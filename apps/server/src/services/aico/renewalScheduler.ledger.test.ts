// @vitest-environment node
import type { LobeChatDatabase } from '@lobechat/database';
import { getTestDB } from '@lobechat/database/test-utils';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { cleanupAicoTables, seedUsers } from '@/database/models/__tests__/aico.phase2.helpers';
import { OrganizationModel } from '@/database/models/organization';
import {
  aicoKeyOutbox,
  aicoRenewalBatches,
  memberBudgets,
} from '@/database/schemas/aicoOrganization';
import type { ManagedProviderClient } from '@/server/services/managedProvider';
import { AicoOpenRouterKeyService } from '@/server/services/openrouter/keyService';

import { processDueRenewals, processKeyOutbox } from './renewalScheduler';

const ledger = vi.hoisted(() => ({ authoritative: false, paused: false, shared: false }));

vi.mock('@/server/services/aico/ledger/config', () => ({
  isSharedInferenceKey: () => ledger.shared,
}));

vi.mock('@/server/services/aico/ledger/state', () => ({
  isLedgerAuthoritative: async () => ledger.authoritative,
  isLedgerPaused: async () => ledger.paused,
}));

const usd = (n: number) => Math.round(n * 1_000_000);
const ownerId = 'ledger-renewal-owner';

let db: LobeChatDatabase;
let orgModel: OrganizationModel;

/** Any upstream call is a bug under the authoritative ledger. */
const unreachableProvider = () =>
  ({
    capabilities: {
      nativePeriodicLimits: false,
      readKeyBySecret: true,
      revoke: false,
      updateLimit: false,
    },
    createKey: vi.fn(async () => {
      throw new Error('unexpected createKey');
    }),
    getAccountBalanceUsd: vi.fn(async () => 0),
    getKey: vi.fn(async () => {
      throw new Error('unexpected getKey');
    }),
    providerId: 'cheapvibecode',
  }) as unknown as ManagedProviderClient;

beforeEach(async () => {
  ledger.authoritative = false;
  ledger.paused = false;
  ledger.shared = false;
  db = await getTestDB();
  await db.delete(aicoKeyOutbox);
  await db.delete(aicoRenewalBatches);
  await cleanupAicoTables(db);
  await seedUsers(db, [{ email: 'ledger-renewal@example.com', id: ownerId }]);
  orgModel = new OrganizationModel(db);
});

const setupDueBudget = async (values: Partial<typeof memberBudgets.$inferInsert>) => {
  const org = await orgModel.createOrganization({ name: 'Ledger Renew', ownerUserId: ownerId });
  await orgModel.addManualCredit({
    amountMicroUsd: usd(20),
    amountToman: 100_000,
    createdByUserId: ownerId,
    fxRateTomanPerUsd: 5000,
    orgId: org.id,
  });
  const me = (await orgModel.listMembers(org.id)).find((m) => m.userId === ownerId)!;
  await orgModel.allocateMemberCredit({
    createdByUserId: ownerId,
    orgId: org.id,
    orgMemberId: me.id,
    period: 'daily',
    periodAmountMicroUsd: usd(5),
  });
  await db
    .update(memberBudgets)
    .set({ nextRenewalAt: new Date(Date.now() - 60_000), ...values })
    .where(eq(memberBudgets.orgMemberId, me.id));
  return { member: me, org };
};

describe('renewals under the usage ledger', () => {
  it('moves no money while the ledger is paused', async () => {
    const { member, org } = await setupDueBudget({});
    await db.insert(aicoKeyOutbox).values({
      action: 'disable_member_key',
      nextAttemptAt: new Date(Date.now() - 60_000),
      orgId: org.id,
      orgMemberId: member.id,
    });
    ledger.paused = true;

    await expect(processDueRenewals(db)).resolves.toEqual([]);
    await expect(processKeyOutbox(db)).resolves.toEqual({
      deferred: 0,
      failed: 0,
      processed: 0,
      succeeded: 0,
    });

    const budget = await orgModel.getMemberBudget(member.id);
    expect(budget?.renewalStatus).toBe('active');
    const [row] = await db.select().from(aicoKeyOutbox);
    expect(row.status).toBe('pending');
  });

  it('bumps the budget epoch and leaves open holds alone', async () => {
    const { member } = await setupDueBudget({ heldMicroUsd: usd(1), openHolds: 1 });
    const keyService = {
      disableMemberKey: vi.fn(async () => null),
      ensureMemberKey: vi.fn(async () => ({ created: false, keyId: null })),
      settleMemberPeriod: vi.fn(async () => ({
        nextCycleBaselineMicroUsd: 0,
        remainingMicroUsd: usd(4),
        usageMicroUsd: usd(1),
      })),
    } as unknown as AicoOpenRouterKeyService;

    const [result] = await processDueRenewals(db, { keyService });
    expect(result.status).toBe('funded');

    const budget = await orgModel.getMemberBudget(member.id);
    expect(budget?.ledgerEpoch).toBe(1);
    expect(Number(budget?.heldMicroUsd)).toBe(usd(1));
    expect(budget?.openHolds).toBe(1);
    expect(Number(budget?.settledUsageMicroUsd)).toBe(0);
  });

  it('refunds a keyless budget cycle minus settled minus held, not the full cap', async () => {
    ledger.authoritative = true;
    ledger.shared = true;
    const { member, org } = await setupDueBudget({
      heldMicroUsd: usd(1),
      settledUsageMicroUsd: usd(1),
    });
    const before = Number((await orgModel.getById(org.id))?.walletBalanceMicroUsd);
    const keyService = new AicoOpenRouterKeyService(db, unreachableProvider());

    const [result] = await processDueRenewals(db, { keyService });
    expect(result.status).toBe('funded');

    // Refund $5 − $1 settled − $1 held = $3, then prepay the next $5 cap.
    const after = Number((await orgModel.getById(org.id))?.walletBalanceMicroUsd);
    expect(after).toBe(before + usd(3) - usd(5));
    const budget = await orgModel.getMemberBudget(member.id);
    expect(Number(budget?.reservedMicroUsd)).toBe(usd(5));
  });
});
