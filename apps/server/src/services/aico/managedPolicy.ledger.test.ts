import { OPENROUTER_AUTO_MODEL_ID } from '@lobechat/business-const';
import type { LobeChatDatabase } from '@lobechat/database';
import { getTestDB } from '@lobechat/database/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { cleanupAicoTables, seedUsers } from '@/database/models/__tests__/aico.phase2.helpers';
import { OrganizationModel } from '@/database/models/organization';
import { memberBudgets, userWallets } from '@/database/schemas/aicoOrganization';

import type { LedgerGate } from './ledger/gate';
import { AicoManagedPolicy } from './managedPolicy';

const SHARED = 'sk-shared-test';
const legacyGate: LedgerGate = { authoritative: true, mode: 'enforce', sharedKey: null };
const sharedGate: LedgerGate = { authoritative: true, mode: 'enforce', sharedKey: SHARED };

const userId = 'ledger-policy-user';
const personal = { billing: { source: 'personal' }, modelId: OPENROUTER_AUTO_MODEL_ID, userId };

let db: LobeChatDatabase;

beforeEach(async () => {
  db = await getTestDB();
  await cleanupAicoTables(db);
  await seedUsers(db, [{ email: 'ledger-policy@example.com', id: userId }]);
});

const seedOrgBudget = async (values: Partial<typeof memberBudgets.$inferInsert>) => {
  const orgModel = new OrganizationModel(db);
  const org = await orgModel.createOrganization({ name: 'Ledger Org', ownerUserId: userId });
  const members = await orgModel.listMembers(org.id);
  const me = members.find((m) => m.userId === userId)!;
  await db.insert(memberBudgets).values({
    orgId: org.id,
    orgMemberId: me.id,
    periodAmountMicroUsd: 1_000_000,
    ...values,
  });
  return {
    billing: { organizationId: org.id, source: 'organization' },
    modelId: OPENROUTER_AUTO_MODEL_ID,
    userId,
  };
};

describe('AicoManagedPolicy under the usage ledger', () => {
  it('refuses a wallet whose ledger capacity is used up even with a positive balance', async () => {
    await db.insert(userWallets).values({
      balanceMicroUsd: 5_000_000,
      openrouterKeyCiphertext: 'cipher',
      openrouterKeyId: 'key_1',
      rawCapacityMicroUsd: 1_000_000,
      rawUsedMicroUsd: 1_000_000,
      userId,
    });
    const policy = new AicoManagedPolicy(db, async () => 'decrypted', undefined, sharedGate);

    await expect(policy.authorize(personal)).rejects.toMatchObject({
      code: 'PERSONAL_FUNDS_UNAVAILABLE',
    });
  });

  it('counts open holds against the wallet', async () => {
    await db.insert(userWallets).values({
      balanceMicroUsd: 5_000_000,
      rawCapacityMicroUsd: 1_000_000,
      rawHeldMicroUsd: 400_000,
      rawUsedMicroUsd: 600_000,
      userId,
    });
    const policy = new AicoManagedPolicy(db, async () => null, undefined, sharedGate);

    await expect(policy.authorize(personal)).rejects.toMatchObject({
      code: 'PERSONAL_FUNDS_UNAVAILABLE',
    });
  });

  it('hands out the shared key to a keyless wallet without decrypting or repairing', async () => {
    await db.insert(userWallets).values({
      balanceMicroUsd: 1_000_000,
      rawCapacityMicroUsd: 1_000_000,
      userId,
    });
    const decrypt = vi.fn(async () => 'decrypted');
    const ensureUserKey = vi.fn();
    const ensureMemberKey = vi.fn();
    const policy = new AicoManagedPolicy(
      db,
      decrypt,
      { ensureMemberKey, ensureUserKey },
      sharedGate,
    );

    const authorized = await policy.authorize(personal);
    expect(authorized.apiKey).toBe(SHARED);
    expect(decrypt).not.toHaveBeenCalled();
    expect(ensureUserKey).not.toHaveBeenCalled();
  });

  it('still requires a per-subject key when the gate has no shared key', async () => {
    await db.insert(userWallets).values({
      balanceMicroUsd: 1_000_000,
      rawCapacityMicroUsd: 1_000_000,
      userId,
    });
    const policy = new AicoManagedPolicy(db, async () => 'decrypted', undefined, legacyGate);

    await expect(policy.authorize(personal)).rejects.toMatchObject({
      code: 'MANAGED_KEY_UNAVAILABLE',
    });
  });

  it('keeps the deposit-based check without a gate', async () => {
    await db.insert(userWallets).values({
      balanceMicroUsd: 5_000_000,
      openrouterKeyCiphertext: 'cipher',
      openrouterKeyId: 'key_1',
      rawCapacityMicroUsd: 1_000_000,
      rawUsedMicroUsd: 1_000_000,
      userId,
    });
    // Legacy keys minted before migration 0154 carry no provider stamp.
    const policy = new AicoManagedPolicy(db, async () => 'decrypted');

    const outcome = await policy.authorize(personal).catch((error: { code?: string }) => error);
    expect((outcome as { code?: string }).code).not.toBe('PERSONAL_FUNDS_UNAVAILABLE');
  });

  it('authorizes an organization member without a budget key under the shared key', async () => {
    const params = await seedOrgBudget({});
    const ensureMemberKey = vi.fn();
    const policy = new AicoManagedPolicy(db, async () => null, { ensureMemberKey }, sharedGate);

    const authorized = await policy.authorize(params);
    expect(authorized.apiKey).toBe(SHARED);
    expect(authorized.budgetId).toBeTruthy();
    expect(ensureMemberKey).not.toHaveBeenCalled();
  });

  it('counts held spend against the member budget', async () => {
    const params = await seedOrgBudget({ heldMicroUsd: 100, settledUsageMicroUsd: 999_900 });
    const policy = new AicoManagedPolicy(db, async () => null, undefined, sharedGate);

    await expect(policy.authorize(params)).rejects.toMatchObject({
      code: 'MEMBER_BUDGET_UNFUNDED',
    });
  });
});
