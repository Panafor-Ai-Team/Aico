/**
 * Renewal must never refund more than the closing cycle funded: one refund per
 * key, capped at cycle cap − usage.
 */
// @vitest-environment node
import type { LobeChatDatabase } from '@lobechat/database';
import { getTestDB } from '@lobechat/database/test-utils';
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OrganizationModel } from '@/database/models/organization';
import { users } from '@/database/schemas';
import {
  aicoKeyOutbox,
  aicoRenewalBatches,
  memberBudgets,
  organizationMembers,
  organizations,
  organizationTeamMembers,
  organizationTeams,
  walletTransactions,
} from '@/database/schemas/aicoOrganization';
import { processDueRenewals } from '@/server/services/aico/renewalScheduler';
import { sendSecurityAlert } from '@/server/services/aico/securityAlert';
import type { AicoOpenRouterKeyService } from '@/server/services/openrouter/keyService';

vi.mock('@/server/services/aico/securityAlert', () => ({
  sendSecurityAlert: vi.fn(async () => ({ sent: true })),
}));

const usd = (n: number) => Math.round(n * 1_000_000);
const ownerId = 'aico-dr-owner';
const memberIds = ['aico-dr-member-a', 'aico-dr-member-b'];

describe('processDueRenewals refund safety', () => {
  let serverDB: LobeChatDatabase;
  let orgModel: OrganizationModel;

  const clean = async () => {
    await serverDB.delete(aicoKeyOutbox);
    await serverDB.delete(aicoRenewalBatches);
    await serverDB.delete(walletTransactions);
    await serverDB.delete(memberBudgets);
    await serverDB.delete(organizationTeamMembers);
    await serverDB.delete(organizationTeams);
    await serverDB.delete(organizationMembers);
    await serverDB.delete(organizations);
    await serverDB.delete(users);
  };

  beforeEach(async () => {
    serverDB = await getTestDB();
    orgModel = new OrganizationModel(serverDB);
    vi.mocked(sendSecurityAlert).mockClear();
    await clean();
    await serverDB
      .insert(users)
      .values([
        { email: 'owner-dr@example.com', id: ownerId },
        ...memberIds.map((id) => ({ email: `${id}@example.com`, id })),
      ]);
  });

  afterEach(async () => {
    await clean();
  });

  /** Daily $5 budgets with $3 spent, one per member, due for renewal. */
  const setupOrg = async (memberCount: number, orgWalletUsd: number) => {
    const org = await orgModel.createOrganization({ name: 'Refund Co', ownerUserId: ownerId });
    await orgModel.addManualCredit({
      amountMicroUsd: usd(orgWalletUsd),
      amountToman: orgWalletUsd * 5000,
      createdByUserId: ownerId,
      fxRateTomanPerUsd: 5000,
      orgId: org.id,
    });

    const members = [];
    for (const userId of memberIds.slice(0, memberCount)) {
      const invite = await orgModel.createInvite({
        identifierType: 'email',
        identifierValue: `${userId}@example.com`,
        invitedByUserId: ownerId,
        orgId: org.id,
        role: 'member',
      });
      const { member } = await orgModel.acceptInvite({
        email: `${userId}@example.com`,
        token: invite.token,
        userId,
      });
      await orgModel.allocateMemberCredit({
        createdByUserId: ownerId,
        orgId: org.id,
        orgMemberId: member.id,
        period: 'daily',
        periodAmountMicroUsd: usd(5),
      });
      await serverDB
        .update(memberBudgets)
        .set({
          nextRenewalAt: new Date(Date.now() - 60_000),
          openrouterKeyCiphertext: 'cipher',
          openrouterKeyId: `key-${userId}`,
          settledUsageMicroUsd: usd(3),
        })
        .where(eq(memberBudgets.orgMemberId, member.id));
      members.push(member);
    }
    return { members, org };
  };

  const mockKeyService = (remainingMicroUsd: number): AicoOpenRouterKeyService =>
    ({
      disableMemberKey: vi.fn(async () => null),
      ensureMemberKey: vi.fn(async () => ({ created: false, keyId: 'mock-key' })),
      settleMemberPeriod: vi.fn(async () => ({ remainingMicroUsd, usageMicroUsd: usd(3) })),
    }) as unknown as AicoOpenRouterKeyService;

  it('rejects a second budget on the same key', async () => {
    const { members } = await setupOrg(2, 20);

    await expect(
      serverDB
        .update(memberBudgets)
        .set({ openrouterKeyId: `key-${memberIds[0]}` })
        .where(eq(memberBudgets.orgMemberId, members[1].id)),
    ).rejects.toThrow();
  });

  it('refunds a key shared by two budgets only once', async () => {
    const { members, org } = await setupOrg(2, 20);
    // Simulates rows written before the unique index existed.
    await serverDB.execute(sql`DROP INDEX "member_budgets_openrouter_key_id_uidx"`);
    try {
      await serverDB
        .update(memberBudgets)
        .set({ openrouterKeyId: `key-${memberIds[0]}` })
        .where(eq(memberBudgets.orgMemberId, members[1].id));

      const [result] = await processDueRenewals(serverDB, { keyService: mockKeyService(usd(2)) });

      expect(result.status).toBe('funded');
      expect(result.refundedMicroUsd).toBe(usd(2));
      // $20 − $10 allocated + $2 refunded once − $10 renewed.
      expect(Number((await orgModel.getById(org.id))?.walletBalanceMicroUsd)).toBe(usd(2));
      expect(sendSecurityAlert).toHaveBeenCalledWith(
        serverDB,
        expect.objectContaining({ severity: 'critical', type: 'renewal.duplicate_key' }),
      );
    } finally {
      await serverDB.update(memberBudgets).set({ openrouterKeyId: null });
      await serverDB.execute(
        sql`CREATE UNIQUE INDEX IF NOT EXISTS "member_budgets_openrouter_key_id_uidx" ON "member_budgets" ("openrouter_key_id") WHERE "openrouter_key_id" IS NOT NULL`,
      );
    }
  });

  it('caps a refund at what the cycle funded', async () => {
    const { org } = await setupOrg(1, 20);

    // Provider claims $9 left on a $5 cycle with $3 spent.
    const [result] = await processDueRenewals(serverDB, { keyService: mockKeyService(usd(9)) });

    expect(result.status).toBe('funded');
    expect(result.refundedMicroUsd).toBe(usd(2));
    // $20 − $5 allocated + $2 refunded − $5 renewed.
    expect(Number((await orgModel.getById(org.id))?.walletBalanceMicroUsd)).toBe(usd(12));
    expect(sendSecurityAlert).toHaveBeenCalledWith(
      serverDB,
      expect.objectContaining({ type: 'renewal.refund_over_cap' }),
    );
  });

  it('refunds a normal cycle in full without alerting', async () => {
    const { org } = await setupOrg(1, 20);

    const [result] = await processDueRenewals(serverDB, { keyService: mockKeyService(usd(2)) });

    expect(result.refundedMicroUsd).toBe(usd(2));
    expect(Number((await orgModel.getById(org.id))?.walletBalanceMicroUsd)).toBe(usd(12));
    expect(sendSecurityAlert).not.toHaveBeenCalled();
  });
});
