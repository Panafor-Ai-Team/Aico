// @vitest-environment node
import type { LobeChatDatabase } from '@lobechat/database';
import { getTestDB } from '@lobechat/database/test-utils';
import { and, eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { cleanupAicoTables, seedUsers } from '@/database/models/__tests__/aico.phase2.helpers';
import { AicoUsageLedgerModel } from '@/database/models/aicoUsageLedger';
import { OrganizationModel } from '@/database/models/organization';
import {
  aicoKeyOutbox,
  aicoRenewalBatches,
  memberBudgets,
  walletTransactions,
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

  it('bumps the budget epoch and moves the closed cycle’s holds out of the new one', async () => {
    // Not authoritative: nothing was withheld for the open hold, so nothing is owed back.
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
    expect(Number(budget?.heldMicroUsd)).toBe(0);
    expect(budget?.openHolds).toBe(0);
    expect(Number(budget?.closedHoldPoolMicroUsd)).toBe(0);
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
    // The $1 withheld for the open hold is parked, and the new cycle starts clean.
    expect(Number(budget?.closedHoldPoolMicroUsd)).toBe(usd(1));
    expect(Number(budget?.heldMicroUsd)).toBe(0);
    expect(budget?.openHolds).toBe(0);
    expect(budget?.ledgerEpoch).toBe(1);
  });

  describe('an enforce hold that straddles the renewal', () => {
    /** A $0.36 billed hold; settling it for $0.12 leaves $0.24 unused. */
    const HOLD_BILLED = 360_000;
    const CHARGE_BILLED = 120_000;
    const ledgerModel = () => new AicoUsageLedgerModel(db);

    const placeHold = async (orgId: string, memberId: string) => {
      const budget = (await orgModel.getMemberBudget(memberId))!;
      const placed = await ledgerModel().placeHold({
        billingSource: 'organization',
        estInputTokens: 1000,
        holdRawMicroUsd: 300_000,
        maxOpenHolds: 6,
        maxOutputTokens: 32_000,
        modelId: 'glm-5.3-flash',
        modelMultiplierBp: 10_000,
        multiplierBp: 12_000,
        operation: 'chat',
        pricedModelId: 'glm-5.3-flash',
        subject: {
          budgetId: budget.id,
          orgId,
          orgMemberId: memberId,
          type: 'budget',
          userId: ownerId,
        },
        ttlSeconds: 900,
      });
      if (!placed.ok) throw new Error(`expected hold: ${JSON.stringify(placed.refusal)}`);
      return placed.holdId;
    };

    const lateRows = (orgId: string) =>
      db
        .select()
        .from(walletTransactions)
        .where(
          and(
            eq(walletTransactions.orgId, orgId),
            sql`${walletTransactions.metadata}->>'reason' = 'late_settle'`,
          ),
        );

    it('refunds the cycle without the hold, then returns what the hold did not use, once', async () => {
      ledger.authoritative = true;
      ledger.shared = true;
      const { member, org } = await setupDueBudget({});
      const holdId = await placeHold(org.id, member.id);
      const before = Number((await orgModel.getById(org.id))?.walletBalanceMicroUsd);
      const keyService = new AicoOpenRouterKeyService(db, unreachableProvider());

      const [result] = await processDueRenewals(db, { keyService });
      expect(result.status).toBe('funded');

      // Refund $5 − $0.36 held, then prepay the next $5 cap.
      const afterRenewal = Number((await orgModel.getById(org.id))?.walletBalanceMicroUsd);
      expect(afterRenewal).toBe(before + usd(5) - HOLD_BILLED - usd(5));
      expect(await orgModel.getMemberBudget(member.id)).toMatchObject({
        closedHoldPoolMicroUsd: HOLD_BILLED,
        heldMicroUsd: 0,
        ledgerEpoch: 1,
        openHolds: 0,
      });

      await ledgerModel().settleHold(holdId, { chargedRawMicroUsd: 100_000, reason: 'usage' });

      expect(Number((await orgModel.getById(org.id))?.walletBalanceMicroUsd)).toBe(
        afterRenewal + HOLD_BILLED - CHARGE_BILLED,
      );
      expect(await lateRows(org.id)).toHaveLength(1);
      expect(await orgModel.getMemberBudget(member.id)).toMatchObject({
        closedHoldPoolMicroUsd: 0,
        settledUsageMicroUsd: 0,
      });
    });

    it('refunds from the locked row when the hold settles between the read and the funding transaction', async () => {
      ledger.authoritative = true;
      const { member, org } = await setupDueBudget({});
      const holdId = await placeHold(org.id, member.id);
      const before = Number((await orgModel.getById(org.id))?.walletBalanceMicroUsd);
      const keyService = {
        disableMemberKey: vi.fn(async () => null),
        ensureMemberKey: vi.fn(async () => ({ created: false, keyId: null })),
        // The figures were read with the hold open ($5 − $0.36 held) ...
        settleMemberPeriod: vi.fn(async () => {
          const stale = {
            nextCycleBaselineMicroUsd: 0,
            remainingMicroUsd: usd(5) - HOLD_BILLED,
            usageMicroUsd: HOLD_BILLED,
          };
          // ... and the hold settles right after, in the cycle that is closing.
          await ledgerModel().settleHold(holdId, { chargedRawMicroUsd: 100_000, reason: 'usage' });
          return stale;
        }),
      } as unknown as AicoOpenRouterKeyService;

      const [result] = await processDueRenewals(db, { keyService });
      expect(result.status).toBe('funded');

      // The locked row says $0.12 settled and nothing held: refund $4.88, not $4.64.
      const after = Number((await orgModel.getById(org.id))?.walletBalanceMicroUsd);
      expect(after).toBe(before + usd(5) - CHARGE_BILLED - usd(5));
      expect(result.refundedMicroUsd).toBe(usd(5) - CHARGE_BILLED);
      expect(await lateRows(org.id)).toHaveLength(0);
    });
  });
});
