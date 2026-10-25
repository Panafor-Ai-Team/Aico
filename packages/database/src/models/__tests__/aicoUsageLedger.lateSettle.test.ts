/**
 * C3 / N15 — a hold that settles after its cycle was closed.
 *
 * A ledger close (renewal, reclaim) counts an open hold as used and refunds the
 * cycle without it. Whatever it withheld is parked in the budget's pool, and a
 * late settle returns what the hold did not use from there — never more than
 * was withheld, and never for a close that was not ledger-based.
 *
 * Every close below uses `useLedgerRemaining: true` unless the test says it is
 * a non-ledger one.
 */
import { and, eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import {
  memberBudgets,
  organizations,
  usageHolds,
  walletTransactions,
} from '../../schemas/aicoOrganization';
import type { LobeChatDatabase } from '../../type';
import { applyMultiplierMicroUsd } from '../../utils/aicoMoney';
import { AicoUsageLedgerModel } from '../aicoUsageLedger';
import { OrganizationModel } from '../organization';
import { cleanupAicoTables, seedUsers } from './aico.phase2.helpers';

const serverDB: LobeChatDatabase = await getTestDB();
const orgModel = new OrganizationModel(serverDB);
const ledger = new AicoUsageLedgerModel(serverDB);
const ownerId = 'late-owner';
const memberUserId = 'late-member';
const usd = (n: number) => Math.round(n * 1_000_000);

/** A $0.30 raw hold at 1.2× is a $0.36 billed hold. */
const HOLD_BILLED = applyMultiplierMicroUsd(300_000, 12_000);
/** Settling it for $0.10 raw is a $0.12 charge, so $0.24 is owed back. */
const CHARGE_BILLED = applyMultiplierMicroUsd(100_000, 12_000);

const setup = async () => {
  const org = await orgModel.createOrganization({ name: 'Late Org', ownerUserId: ownerId });
  await orgModel.addManualCredit({
    amountMicroUsd: usd(100),
    amountToman: 5_000_000,
    createdByUserId: ownerId,
    fxRateTomanPerUsd: 50_000,
    orgId: org.id,
  });
  const invite = await orgModel.createInvite({
    identifierType: 'email',
    identifierValue: 'late-member@example.com',
    invitedByUserId: ownerId,
    orgId: org.id,
    role: 'member',
  });
  const { member } = await orgModel.acceptInvite({
    email: 'late-member@example.com',
    token: invite.token,
    userId: memberUserId,
  });
  await allocate(org.id, member.id, 50);
  return { member, org };
};

const allocate = (orgId: string, memberId: string, amountUsd: number) =>
  orgModel.allocateMemberCredit({
    createdByUserId: ownerId,
    orgId,
    orgMemberId: memberId,
    period: 'daily',
    periodAmountMicroUsd: usd(amountUsd),
  });

const readBudget = async (memberId: string) =>
  (await serverDB.query.memberBudgets.findFirst({
    where: eq(memberBudgets.orgMemberId, memberId),
  }))!;

const orgBalance = async (orgId: string) =>
  Number(
    (await serverDB.query.organizations.findFirst({ where: eq(organizations.id, orgId) }))
      ?.walletBalanceMicroUsd,
  );

const holdParams = async (orgId: string, memberId: string) => {
  const budget = await readBudget(memberId);
  return {
    billingSource: 'organization' as const,
    estInputTokens: 1000,
    holdRawMicroUsd: 300_000,
    maxOpenHolds: 6,
    maxOutputTokens: 32_000,
    modelId: 'glm-5.3-flash',
    modelMultiplierBp: 10_000,
    multiplierBp: 12_000,
    operation: 'chat' as const,
    pricedModelId: 'glm-5.3-flash',
    subject: {
      budgetId: budget.id,
      orgId,
      orgMemberId: memberId,
      type: 'budget' as const,
      userId: memberUserId,
    },
    ttlSeconds: 900,
  };
};

const placeHold = async (orgId: string, memberId: string) => {
  const result = await ledger.placeHold(await holdParams(orgId, memberId));
  if (!result.ok) throw new Error(`expected hold: ${JSON.stringify(result.refusal)}`);
  return result.holdId;
};

/** A ledger close: reclaim the budget from its own columns. */
const ledgerClose = (orgId: string, memberId: string) =>
  orgModel.reclaimMemberRemainingCredit({
    orgId,
    orgMemberId: memberId,
    remainingMicroUsd: 0,
    useLedgerRemaining: true,
  });

const lateRows = (orgId: string) =>
  serverDB
    .select()
    .from(walletTransactions)
    .where(
      and(
        eq(walletTransactions.orgId, orgId),
        sql`${walletTransactions.metadata}->>'reason' = 'late_settle'`,
      ),
    );

beforeEach(async () => {
  await cleanupAicoTables(serverDB);
  await seedUsers(serverDB, [
    { email: 'late-owner@example.com', id: ownerId },
    { email: 'late-member@example.com', id: memberUserId },
  ]);
});

afterEach(async () => {
  await cleanupAicoTables(serverDB);
});

describe('late settle after a ledger close', () => {
  it('returns what the hold did not use, once, and keeps the new cycle clean', async () => {
    const { member, org } = await setup();
    const holdId = await placeHold(org.id, member.id);
    const epoch = (await readBudget(member.id)).ledgerEpoch;

    await ledgerClose(org.id, member.id);
    expect(await readBudget(member.id)).toMatchObject({
      closedHoldPoolMicroUsd: HOLD_BILLED,
      heldMicroUsd: 0,
      ledgerEpoch: epoch + 1,
      openHolds: 0,
    });
    const afterClose = await orgBalance(org.id);

    const result = await ledger.settleHold(holdId, {
      chargedRawMicroUsd: 100_000,
      reason: 'usage',
    });

    expect(result).toEqual({ settled: true });
    expect(await orgBalance(org.id)).toBe(afterClose + HOLD_BILLED - CHARGE_BILLED);
    const rows = await lateRows(org.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      amountMicroUsd: HOLD_BILLED - CHARGE_BILLED,
      balanceBeforeMicroUsd: afterClose,
      orgMemberId: member.id,
      type: 'period_refund',
    });
    expect(rows[0].metadata).toMatchObject({ holdId, reason: 'late_settle' });
    expect(await readBudget(member.id)).toMatchObject({
      closedHoldPoolMicroUsd: 0,
      heldMicroUsd: 0,
      openHolds: 0,
      settledUsageMicroUsd: 0,
    });
  });

  it('after a revive, the old hold leaves the new cycle’s holds alone (N15)', async () => {
    const { member, org } = await setup();
    const oldHold = await placeHold(org.id, member.id);
    await ledgerClose(org.id, member.id);
    await allocate(org.id, member.id, 10);
    await placeHold(org.id, member.id);
    expect(await readBudget(member.id)).toMatchObject({ heldMicroUsd: HOLD_BILLED, openHolds: 1 });
    const before = await orgBalance(org.id);

    await ledger.settleHold(oldHold, { chargedRawMicroUsd: 100_000, reason: 'usage' });

    expect(await readBudget(member.id)).toMatchObject({
      heldMicroUsd: HOLD_BILLED,
      openHolds: 1,
      settledUsageMicroUsd: 0,
    });
    expect(await orgBalance(org.id)).toBe(before + HOLD_BILLED - CHARGE_BILLED);
    expect(await lateRows(org.id)).toHaveLength(1);
  });

  it('a second close while the hold is still open does not withhold it again', async () => {
    const { member, org } = await setup();
    const holdId = await placeHold(org.id, member.id);
    await ledgerClose(org.id, member.id);
    await allocate(org.id, member.id, 10);
    const beforeSecondClose = await orgBalance(org.id);

    await ledgerClose(org.id, member.id);

    // The whole $10 cycle comes back: the hold belongs to the first cycle.
    expect(await orgBalance(org.id)).toBe(beforeSecondClose + usd(10));
    expect((await readBudget(member.id)).closedHoldPoolMicroUsd).toBe(HOLD_BILLED);

    const before = await orgBalance(org.id);
    await ledger.settleHold(holdId, { chargedRawMicroUsd: 100_000, reason: 'usage' });
    expect(await orgBalance(org.id)).toBe(before + HOLD_BILLED - CHARGE_BILLED);
    expect(await lateRows(org.id)).toHaveLength(1);
  });

  it('never returns more than the close withheld when the cycle was nearly spent', async () => {
    const { member, org } = await setup();
    const holdId = await placeHold(org.id, member.id);
    // Cycle $1, settled $0.80, hold $0.36: only $0.20 of the hold could be spent.
    await serverDB
      .update(memberBudgets)
      .set({
        periodAmountMicroUsd: usd(1),
        reservedMicroUsd: usd(1),
        settledUsageMicroUsd: usd(0.8),
      })
      .where(eq(memberBudgets.orgMemberId, member.id));

    await ledgerClose(org.id, member.id);
    expect((await readBudget(member.id)).closedHoldPoolMicroUsd).toBe(usd(0.2));
    const before = await orgBalance(org.id);

    await ledger.settleHold(holdId, { chargedRawMicroUsd: 100_000, reason: 'usage' });

    // The hold is $0.36 and used $0.12 ($0.24 unused), but only $0.20 was withheld.
    expect(await orgBalance(org.id)).toBe(before + usd(0.2));
    expect((await readBudget(member.id)).closedHoldPoolMicroUsd).toBe(0);
  });

  it('credits nothing when the call cost more than it reserved, and says by how much', async () => {
    const { member, org } = await setup();
    const holdId = await placeHold(org.id, member.id);
    await ledgerClose(org.id, member.id);
    const before = await orgBalance(org.id);

    const result = await ledger.settleHold(holdId, {
      chargedRawMicroUsd: 500_000,
      reason: 'usage',
    });

    expect(result).toEqual({
      settled: true,
      unchargedMicroUsd: applyMultiplierMicroUsd(500_000, 12_000) - HOLD_BILLED,
    });
    expect(await orgBalance(org.id)).toBe(before);
    expect(await lateRows(org.id)).toHaveLength(0);
    expect((await readBudget(member.id)).closedHoldPoolMicroUsd).toBe(0);
  });

  it('an expired hold is charged in full: its share of the pool empties with no credit', async () => {
    const { member, org } = await setup();
    const holdId = await placeHold(org.id, member.id);
    await ledgerClose(org.id, member.id);
    const before = await orgBalance(org.id);
    await serverDB
      .update(usageHolds)
      .set({ expiresAt: sql`now() - interval '1 minute'` })
      .where(eq(usageHolds.id, holdId));

    expect(await ledger.expireHolds({ limit: 10 })).toBe(1);

    expect(await orgBalance(org.id)).toBe(before);
    expect(await lateRows(org.id)).toHaveLength(0);
    expect((await readBudget(member.id)).closedHoldPoolMicroUsd).toBe(0);
  });

  it('a close that was not ledger-based withholds nothing, so a late settle returns nothing', async () => {
    const { member, org } = await setup();
    const holdId = await placeHold(org.id, member.id);
    // The key-based reclaim figure: the hold was not subtracted from it.
    await orgModel.reclaimMemberRemainingCredit({
      orgId: org.id,
      orgMemberId: member.id,
      remainingMicroUsd: usd(50),
    });
    await allocate(org.id, member.id, 10);
    expect((await readBudget(member.id)).closedHoldPoolMicroUsd).toBe(0);
    const before = await orgBalance(org.id);

    await ledger.settleHold(holdId, { chargedRawMicroUsd: 100_000, reason: 'usage' });

    expect(await orgBalance(org.id)).toBe(before);
    expect(await lateRows(org.id)).toHaveLength(0);
    expect(await readBudget(member.id)).toMatchObject({ heldMicroUsd: 0, openHolds: 0 });
  });

  it('credits nothing, and writes no row, to an organization that was deleted', async () => {
    const { member, org } = await setup();
    const holdId = await placeHold(org.id, member.id);
    await ledgerClose(org.id, member.id);
    await serverDB
      .update(organizations)
      .set({ status: 'deleted' })
      .where(eq(organizations.id, org.id));
    const before = await orgBalance(org.id);

    const result = await ledger.settleHold(holdId, {
      chargedRawMicroUsd: 100_000,
      reason: 'usage',
    });

    expect(result.settled).toBe(true);
    expect(await orgBalance(org.id)).toBe(before);
    expect(await lateRows(org.id)).toHaveLength(0);
  });

  it('leaves a shadow hold alone: nothing is parked, nothing is credited', async () => {
    const { member, org } = await setup();
    const params = await holdParams(org.id, member.id);
    const holdId = await ledger.recordShadowHold({
      ...params,
      refuseReason: null,
      wouldRefuse: false,
    });
    await ledgerClose(org.id, member.id);
    const before = await orgBalance(org.id);

    await ledger.settleHold(holdId, { chargedRawMicroUsd: 100_000, reason: 'usage' });

    expect(await orgBalance(org.id)).toBe(before);
    expect(await lateRows(org.id)).toHaveLength(0);
    expect((await readBudget(member.id)).closedHoldPoolMicroUsd).toBe(0);
  });
});
