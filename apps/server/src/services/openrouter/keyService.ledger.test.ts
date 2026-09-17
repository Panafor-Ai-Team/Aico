// @vitest-environment node
import type { LobeChatDatabase } from '@lobechat/database';
import { getTestDB } from '@lobechat/database/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { cleanupAicoTables, seedUsers } from '@/database/models/__tests__/aico.phase2.helpers';
import { OrganizationModel } from '@/database/models/organization';
import { memberBudgets, userWallets } from '@/database/schemas/aicoOrganization';
import { billedUsageFromCapacity } from '@/database/utils/aicoMoney';
import type { ManagedProviderClient } from '@/server/services/managedProvider';

import { AicoOpenRouterKeyService } from './keyService';

const ledger = vi.hoisted(() => ({ authoritative: false, shared: false }));

vi.mock('@/server/services/aico/ledger/config', () => ({
  isSharedInferenceKey: () => ledger.shared,
}));

vi.mock('@/server/services/aico/ledger/state', () => ({
  isLedgerAuthoritative: async () => ledger.authoritative,
}));

const makeProvider = () => {
  const provider = {
    capabilities: {
      nativePeriodicLimits: false,
      readKeyBySecret: true,
      revoke: false,
      updateLimit: false,
    },
    createKey: vi.fn(async () => {
      throw new Error('createKey must not be called');
    }),
    getAccountBalanceUsd: vi.fn(async () => 1000),
    getKey: vi.fn(async (credential: { hash: string }) => ({
      disabled: false,
      hash: credential.hash,
      limit: null,
      limitRemaining: 0.5,
      name: 'k',
      usage: 0,
      usageDaily: null,
      usageMonthly: null,
      usageWeekly: null,
    })),
    providerId: 'cheapvibecode' as const,
    updateKey: vi.fn(),
  };
  return provider;
};

const userId = 'ledger-keys-user';
let db: LobeChatDatabase;
let provider: ReturnType<typeof makeProvider>;
let keys: AicoOpenRouterKeyService;

beforeEach(async () => {
  ledger.authoritative = false;
  ledger.shared = false;
  db = await getTestDB();
  await cleanupAicoTables(db);
  await seedUsers(db, [{ email: 'ledger-keys@example.com', id: userId }]);
  provider = makeProvider();
  keys = new AicoOpenRouterKeyService(db, provider as unknown as ManagedProviderClient);
});

const seedBudget = async (values: Partial<typeof memberBudgets.$inferInsert>) => {
  const orgModel = new OrganizationModel(db);
  const org = await orgModel.createOrganization({ name: 'Ledger Keys Org', ownerUserId: userId });
  const me = (await orgModel.listMembers(org.id)).find((m) => m.userId === userId)!;
  await db.insert(memberBudgets).values({
    orgId: org.id,
    orgMemberId: me.id,
    periodAmountMicroUsd: 1_000_000,
    ...values,
  });
  return { orgId: org.id, orgMemberId: me.id };
};

describe('AicoOpenRouterKeyService in shared-key mode', () => {
  it('never touches the management client when ensuring keys', async () => {
    ledger.shared = true;
    await db.insert(userWallets).values({
      balanceMicroUsd: 1_000_000,
      rawCapacityMicroUsd: 1_000_000,
      userId,
    });
    const { orgMemberId } = await seedBudget({});

    await expect(keys.ensureUserKey(userId)).resolves.toEqual({ created: false, keyId: null });
    await expect(keys.ensureTrialKey(userId, 1_000_000)).resolves.toEqual({
      created: false,
      keyId: null,
    });
    await expect(keys.ensureMemberKey(orgMemberId)).resolves.toEqual({
      created: false,
      keyId: null,
    });
    expect(provider.createKey).not.toHaveBeenCalled();
    expect(provider.getKey).not.toHaveBeenCalled();
  });

  it('refuses to mint through any internal path', async () => {
    ledger.shared = true;
    const mint = (
      keys as unknown as {
        createAndPersistUserKey: (p: {
          limitUsd: number;
          name: string;
          userId: string;
        }) => Promise<unknown>;
      }
    ).createAndPersistUserKey.bind(keys);

    await expect(mint({ limitUsd: 1, name: 'x', userId })).rejects.toThrow(
      'SHARED_INFERENCE_KEY_MODE',
    );
    expect(provider.createKey).not.toHaveBeenCalled();
  });
});

describe('AicoOpenRouterKeyService under the authoritative ledger', () => {
  beforeEach(() => {
    ledger.authoritative = true;
  });

  it('reads wallet remaining from ledger columns, counting open holds', async () => {
    await db.insert(userWallets).values({
      balanceMicroUsd: 1_000_000,
      openrouterKeyId: 'cvc_1',
      rawCapacityMicroUsd: 800_000,
      rawHeldMicroUsd: 100_000,
      rawUsedMicroUsd: 200_000,
      userId,
    });

    const committed = billedUsageFromCapacity({
      balanceMicroUsd: 1_000_000,
      fallbackBp: 12_500,
      rawCapacityMicroUsd: 800_000,
      rawUsageMicroUsd: 300_000,
    });
    const usage = billedUsageFromCapacity({
      balanceMicroUsd: 1_000_000,
      fallbackBp: 12_500,
      rawCapacityMicroUsd: 800_000,
      rawUsageMicroUsd: 200_000,
    });

    await expect(keys.getUserRemaining(userId)).resolves.toEqual({
      remainingMicroUsd: 1_000_000 - committed,
      usageKnown: true,
      usageMicroUsd: usage,
    });
    expect(provider.getKey).not.toHaveBeenCalled();
  });

  it('peeks, settles and reclaims a keyless budget net of held spend', async () => {
    const params = await seedBudget({
      heldMicroUsd: 300_000,
      pendingPeriodAmountMicroUsd: 50_000,
      settledUsageMicroUsd: 200_000,
    });

    await expect(keys.peekMemberRemaining(params)).resolves.toEqual({
      keyId: null,
      keyProviderId: null,
      remainingMicroUsd: 550_000,
      usageMicroUsd: 500_000,
    });
    await expect(keys.settleMemberPeriod(params.orgMemberId)).resolves.toEqual({
      nextCycleBaselineMicroUsd: 0,
      remainingMicroUsd: 500_000,
      usageMicroUsd: 500_000,
    });
    await expect(keys.reclaimMemberKey(params)).resolves.toEqual({
      remainingMicroUsd: 550_000,
      usageMicroUsd: 500_000,
    });
    expect(provider.updateKey).not.toHaveBeenCalled();
    expect(provider.getKey).not.toHaveBeenCalled();
  });

  it('does not sync member usage from a key', async () => {
    const { orgMemberId } = await seedBudget({ openrouterKeyId: 'cvc_m' });
    await expect(keys.syncMemberCycleUsage(orgMemberId)).resolves.toBeNull();
    expect(provider.getKey).not.toHaveBeenCalled();
  });
});

describe('readWalletRawUsage', () => {
  const wallet = (values: Partial<typeof userWallets.$inferInsert>) =>
    db.insert(userWallets).values({
      balanceMicroUsd: 1_000_000,
      rawCapacityMicroUsd: 800_000,
      rawUsageBeforeKeyMicroUsd: 50_000,
      settledUsageMicroUsd: 500_000,
      userId,
      ...values,
    });
  // ceil(500_000 settled × 800_000 capacity / 1_000_000 balance)
  const fallback = { degraded: true, rawUsedMicroUsd: 400_000 };

  it('reads carried-over spend for a keyless wallet', async () => {
    await wallet({});
    await expect(keys.readWalletRawUsage(userId)).resolves.toEqual({
      degraded: false,
      rawUsedMicroUsd: 50_000,
    });
  });

  it('degrades for a stale or foreign key without reading it', async () => {
    await wallet({ managedKeyProviderId: 'openrouter', openrouterKeyId: 'or_1' });
    await expect(keys.readWalletRawUsage(userId)).resolves.toEqual(fallback);
    expect(provider.getKey).not.toHaveBeenCalled();
  });

  it('adds live spend on the current key', async () => {
    await wallet({
      managedKeyLimitMicroUsd: 800_000,
      managedKeyProviderId: 'cheapvibecode',
      openrouterKeyId: 'cvc_1',
    });
    // limit 800_000 − remaining 500_000 = 300_000 on the key, plus 50_000 before it.
    await expect(keys.readWalletRawUsage(userId)).resolves.toEqual({
      degraded: false,
      rawUsedMicroUsd: 350_000,
    });
  });

  it('degrades when the key has no recorded limit', async () => {
    await wallet({ managedKeyProviderId: 'cheapvibecode', openrouterKeyId: 'cvc_1' });
    await expect(keys.readWalletRawUsage(userId)).resolves.toEqual(fallback);
  });

  it('degrades on a permanent key error and throws on a transient one', async () => {
    await wallet({
      managedKeyLimitMicroUsd: 800_000,
      managedKeyProviderId: 'cheapvibecode',
      openrouterKeyId: 'cvc_1',
    });

    provider.getKey.mockRejectedValueOnce(new Error('CheapVibeCode API 404: Not Found'));
    await expect(keys.readWalletRawUsage(userId)).resolves.toEqual(fallback);

    provider.getKey.mockRejectedValueOnce(new Error('CheapVibeCode API 503: Service Unavailable'));
    await expect(keys.readWalletRawUsage(userId)).rejects.toThrow('503');
  });
});
