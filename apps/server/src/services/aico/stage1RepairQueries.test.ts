// @vitest-environment node
import type { LobeChatDatabase } from '@lobechat/database';
import { getTestDB } from '@lobechat/database/test-utils';
import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { cleanupAicoTables, seedUsers } from '@/database/models/__tests__/aico.phase2.helpers';
import { AicoBillingModel } from '@/database/models/aicoBilling';
import { OrganizationModel } from '@/database/models/organization';
import {
  memberBudgets,
  organizationMembers,
  userWallets,
  walletTransactions,
} from '@/database/schemas/aicoOrganization';

import {
  R1_UNSETTLED_REMOVED_MEMBERS,
  R5_REFUND_AFTER_RECLAIM,
  R6_BASELINE_KEY_CANDIDATES,
  W1_DEBITED_WALLETS_WITH_KEY,
} from './stage1RepairQueries';

const ownerId = 'repair-owner';
const memberUserId = 'repair-member';
const usd = (n: number) => Math.round(n * 1_000_000);

let db: LobeChatDatabase;

const rows = async (query: string) =>
  ((await db.execute(sql.raw(query))) as unknown as { rows: Record<string, unknown>[] }).rows;

const setupMember = async () => {
  const orgModel = new OrganizationModel(db);
  const org = await orgModel.createOrganization({ name: 'Repair Org', ownerUserId: ownerId });
  await orgModel.addManualCredit({
    amountMicroUsd: usd(100),
    amountToman: 5_000_000,
    createdByUserId: ownerId,
    fxRateTomanPerUsd: 50_000,
    orgId: org.id,
  });
  const invite = await orgModel.createInvite({
    identifierType: 'email',
    identifierValue: 'repair-member@example.com',
    invitedByUserId: ownerId,
    orgId: org.id,
    role: 'member',
  });
  const { member } = await orgModel.acceptInvite({
    email: 'repair-member@example.com',
    token: invite.token,
    userId: memberUserId,
  });
  await orgModel.allocateMemberCredit({
    createdByUserId: ownerId,
    orgId: org.id,
    orgMemberId: member.id,
    period: 'daily',
    periodAmountMicroUsd: usd(12),
  });
  return { member, org, orgModel };
};

beforeEach(async () => {
  db = await getTestDB();
  await cleanupAicoTables(db);
  await seedUsers(db, [
    { email: 'repair-owner@example.com', id: ownerId },
    { email: 'repair-member@example.com', id: memberUserId },
  ]);
});

describe('stage-1 repair dry-run queries', () => {
  it('R1 lists a removed member whose budget was never settled, and only that', async () => {
    const { member } = await setupMember();
    expect(await rows(R1_UNSETTLED_REMOVED_MEMBERS)).toHaveLength(0);

    await db
      .update(organizationMembers)
      .set({ leftAt: new Date(), status: 'revocation_pending' })
      .where(eq(organizationMembers.id, member.id));

    const found = await rows(R1_UNSETTLED_REMOVED_MEMBERS);
    expect(found).toHaveLength(1);
    expect(found[0].org_member_id).toBe(member.id);

    await db
      .update(memberBudgets)
      .set({ renewalStatus: 'settled' })
      .where(eq(memberBudgets.orgMemberId, member.id));
    expect(await rows(R1_UNSETTLED_REMOVED_MEMBERS)).toHaveLength(0);
  });

  it('R6 lists a CVC key re-allocated after a reclaim that still carries a baseline', async () => {
    const { member, org, orgModel } = await setupMember();
    await orgModel.reclaimMemberRemainingCredit({
      orgId: org.id,
      orgMemberId: member.id,
      remainingMicroUsd: usd(12),
    });
    await orgModel.allocateMemberCredit({
      createdByUserId: ownerId,
      orgId: org.id,
      orgMemberId: member.id,
      period: 'daily',
      periodAmountMicroUsd: usd(12),
    });
    await db
      .update(memberBudgets)
      .set({
        managedKeyLimitMicroUsd: usd(310),
        managedKeyProviderId: 'cheapvibecode',
        openrouterKeyCiphertext: 'cipher',
        openrouterKeyId: 'cvc_1',
        usageBaselineMicroUsd: usd(300),
      })
      .where(eq(memberBudgets.orgMemberId, member.id));

    const found = await rows(R6_BASELINE_KEY_CANDIDATES);
    expect(found).toHaveLength(1);
    expect(found[0].openrouter_key_id).toBe('cvc_1');
  });

  it('R5 lists a period refund paid after a reclaim with no re-allocation between', async () => {
    const { member, org, orgModel } = await setupMember();
    await orgModel.reclaimMemberRemainingCredit({
      orgId: org.id,
      orgMemberId: member.id,
      remainingMicroUsd: usd(8),
    });
    expect(await rows(R5_REFUND_AFTER_RECLAIM)).toHaveLength(0);

    await db.insert(walletTransactions).values({
      amountMicroUsd: usd(8),
      amountToman: 0,
      balanceAfterMicroUsd: 0,
      balanceBeforeMicroUsd: 0,
      createdAt: new Date(Date.now() + 60_000),
      description: 'Period refund',
      orgId: org.id,
      orgMemberId: member.id,
      type: 'period_refund',
      userId: memberUserId,
    });

    const found = await rows(R5_REFUND_AFTER_RECLAIM);
    expect(found).toHaveLength(1);
    expect(Number(found[0].refunded_micro_usd)).toBe(usd(8));
  });

  it('R5 does not list a late-settle refund: it returns a hold the close withheld', async () => {
    const { member, org, orgModel } = await setupMember();
    await orgModel.reclaimMemberRemainingCredit({
      orgId: org.id,
      orgMemberId: member.id,
      remainingMicroUsd: usd(8),
    });
    await db.insert(walletTransactions).values({
      amountMicroUsd: usd(0.24),
      amountToman: 0,
      balanceAfterMicroUsd: 0,
      balanceBeforeMicroUsd: 0,
      createdAt: new Date(Date.now() + 60_000),
      description: 'Late settle refund for hold test',
      metadata: { holdId: 'hold_test', reason: 'late_settle' },
      orgId: org.id,
      orgMemberId: member.id,
      type: 'period_refund',
      userId: memberUserId,
    });

    expect(await rows(R5_REFUND_AFTER_RECLAIM)).toHaveLength(0);
  });

  it('W1 lists a fully debited wallet that still has a key', async () => {
    const billing = new AicoBillingModel(db);
    await billing.manualCreditUser({
      amountMicroUsd: usd(10),
      amountToman: 500_000,
      createdByUserId: ownerId,
      fxRateTomanPerUsd: 50_000,
      userId: memberUserId,
    });
    await db
      .update(userWallets)
      .set({
        openrouterKeyCiphertext: 'cipher',
        openrouterKeyId: 'cvc_w',
        settledUsageMicroUsd: usd(4),
      })
      .where(eq(userWallets.userId, memberUserId));
    await billing.manualDebitUser({
      amountMicroUsd: usd(6),
      description: 'take back',
      idempotencyKey: 'repair-w1-debit',
      userId: memberUserId,
    });

    const found = await rows(W1_DEBITED_WALLETS_WITH_KEY);
    expect(found).toHaveLength(1);
    expect(found[0].user_id).toBe(memberUserId);
  });
});
