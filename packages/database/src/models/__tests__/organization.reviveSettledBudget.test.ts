/**
 * R7 — re-allocating a budget that a revoke/reclaim settled starts a clean
 * cycle: the closed cycle's usage, checkpoint, holds and window do not carry
 * into it, and the org is debited exactly the requested amount.
 */
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import { memberBudgets, organizations, walletTransactions } from '../../schemas/aicoOrganization';
import type { LobeChatDatabase } from '../../type';
import { AicoUsageLedgerModel } from '../aicoUsageLedger';
import { OrganizationModel } from '../organization';
import { cleanupAicoTables, seedUsers } from './aico.phase2.helpers';

const serverDB: LobeChatDatabase = await getTestDB();
const orgModel = new OrganizationModel(serverDB);
const ownerId = 'revive-owner';
const memberUserId = 'revive-member';
const usd = (n: number) => Math.round(n * 1_000_000);

const setup = async () => {
  const org = await orgModel.createOrganization({ name: 'Revive Org', ownerUserId: ownerId });
  await orgModel.addManualCredit({
    amountMicroUsd: usd(100),
    amountToman: 5_000_000,
    createdByUserId: ownerId,
    fxRateTomanPerUsd: 50_000,
    orgId: org.id,
  });
  const invite = await orgModel.createInvite({
    identifierType: 'email',
    identifierValue: 'revive-member@example.com',
    invitedByUserId: ownerId,
    orgId: org.id,
    role: 'member',
  });
  const { member } = await orgModel.acceptInvite({
    email: 'revive-member@example.com',
    token: invite.token,
    userId: memberUserId,
  });
  await orgModel.allocateMemberCredit({
    createdByUserId: ownerId,
    orgId: org.id,
    orgMemberId: member.id,
    period: 'daily',
    periodAmountMicroUsd: usd(50),
  });
  return { member, org };
};

/** Spend `usedUsd` of the cycle, then revoke: the reclaim settles the budget. */
const spendThenRevoke = async (orgId: string, memberId: string, usedUsd: number) => {
  await serverDB
    .update(memberBudgets)
    .set({
      billedUsageBeforeBaselineMicroUsd: usd(usedUsd),
      settledUsageMicroUsd: usd(usedUsd),
      usageBaselineMicroUsd: usd(300),
    })
    .where(eq(memberBudgets.orgMemberId, memberId));
  await orgModel.reclaimMemberRemainingCredit({
    orgId,
    orgMemberId: memberId,
    remainingMicroUsd: usd(50 - usedUsd),
  });
};

const orgBalance = async (orgId: string) =>
  Number(
    (await serverDB.query.organizations.findFirst({ where: eq(organizations.id, orgId) }))
      ?.walletBalanceMicroUsd,
  );

const readBudget = async (memberId: string) =>
  (await serverDB.query.memberBudgets.findFirst({
    where: eq(memberBudgets.orgMemberId, memberId),
  }))!;

beforeEach(async () => {
  await cleanupAicoTables(serverDB);
  await seedUsers(serverDB, [
    { email: 'revive-owner@example.com', id: ownerId },
    { email: 'revive-member@example.com', id: memberUserId },
  ]);
});

afterEach(async () => {
  await cleanupAicoTables(serverDB);
});

describe('allocateMemberCredit on a settled budget (R7)', () => {
  it.each([
    ['above', 40],
    ['below', 4],
  ])('starts a clean cycle when prior usage is %s the requested amount', async (_, usedUsd) => {
    const { member, org } = await setup();
    await spendThenRevoke(org.id, member.id, usedUsd);
    const settled = await readBudget(member.id);
    const before = await orgBalance(org.id);

    await orgModel.allocateMemberCredit({
      createdByUserId: ownerId,
      orgId: org.id,
      orgMemberId: member.id,
      period: 'daily',
      periodAmountMicroUsd: usd(10),
    });

    // Exactly the requested amount — the closed cycle's usage is not re-charged.
    expect(await orgBalance(org.id)).toBe(before - usd(10));
    const budget = await readBudget(member.id);
    expect(budget).toMatchObject({
      billedUsageBeforeBaselineMicroUsd: 0,
      heldMicroUsd: 0,
      isActive: true,
      ledgerEpoch: settled.ledgerEpoch + 1,
      openHolds: 0,
      periodAmountMicroUsd: usd(10),
      renewalStatus: 'active',
      reservedMicroUsd: usd(10),
      settledUsageMicroUsd: 0,
      usageBaselineMicroUsd: 0,
    });
    // A fresh window: the stale boundary would collide with funded batches.
    expect(budget.nextRenewalAt!.getTime()).toBeGreaterThan(Date.now());
    expect(budget.currentPeriodStart!.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('replays an idempotent re-allocation without a second debit', async () => {
    const { member, org } = await setup();
    await spendThenRevoke(org.id, member.id, 40);
    const before = await orgBalance(org.id);
    const args = {
      createdByUserId: ownerId,
      idempotencyKey: 'revive-replay-key',
      orgId: org.id,
      orgMemberId: member.id,
      period: 'daily' as const,
      periodAmountMicroUsd: usd(10),
    };

    const first = await orgModel.allocateMemberCredit(args);
    const second = await orgModel.allocateMemberCredit(args);

    expect(second.transaction?.id).toBe(first.transaction?.id);
    expect(await orgBalance(org.id)).toBe(before - usd(10));
    const allocates = await serverDB
      .select()
      .from(walletTransactions)
      .where(eq(walletTransactions.gatewayRefId, 'revive-replay-key'));
    expect(allocates).toHaveLength(1);
  });

  it('a hold from the closed cycle does not charge the new one', async () => {
    const { member, org } = await setup();
    const budget = await readBudget(member.id);
    const ledger = new AicoUsageLedgerModel(serverDB);
    const placed = await ledger.placeHold({
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
        orgId: org.id,
        orgMemberId: member.id,
        type: 'budget',
        userId: memberUserId,
      },
      ttlSeconds: 900,
    });
    if (!placed.ok) throw new Error(`expected hold: ${JSON.stringify(placed.refusal)}`);

    await spendThenRevoke(org.id, member.id, 4);
    await orgModel.allocateMemberCredit({
      createdByUserId: ownerId,
      orgId: org.id,
      orgMemberId: member.id,
      period: 'daily',
      periodAmountMicroUsd: usd(10),
    });
    await ledger.settleHold(placed.holdId, { chargedRawMicroUsd: 100_000, reason: 'usage' });

    expect(await readBudget(member.id)).toMatchObject({
      heldMicroUsd: 0,
      openHolds: 0,
      settledUsageMicroUsd: 0,
    });
  });
});
