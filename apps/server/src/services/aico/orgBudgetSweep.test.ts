/**
 * Bulk reclaim of every member allowance in an org back to the org wallet.
 */
// @vitest-environment node
import type { LobeChatDatabase } from '@lobechat/database';
import { getTestDB } from '@lobechat/database/test-utils';
import { eq } from 'drizzle-orm';
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
import {
  executeOrgBudgetSweep,
  previewOrgBudgetSweep,
} from '@/server/services/aico/orgBudgetSweep';
import { processDueRenewals } from '@/server/services/aico/renewalScheduler';
import type { AicoOpenRouterKeyService } from '@/server/services/openrouter/keyService';

const usd = (n: number) => Math.round(n * 1_000_000);

const ownerId = 'aico-sweep-owner';
const memberAId = 'aico-sweep-member-a';
const memberBId = 'aico-sweep-member-b';

describe('org budget sweep', () => {
  let serverDB: LobeChatDatabase;
  let orgModel: OrganizationModel;

  const truncate = async () => {
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
    await truncate();
    await serverDB.insert(users).values([
      { email: 'owner-s@example.com', id: ownerId },
      { email: 'member-a@example.com', id: memberAId },
      { email: 'member-b@example.com', id: memberBId },
    ]);
  });

  afterEach(truncate);

  /** Org funded with `orgWalletUsd`, each entry in `members` allocated a daily cap. */
  const setupOrg = async (params: {
    members: { capUsd: number; email: string; keyId?: string | null; userId: string }[];
    orgWalletUsd: number;
  }) => {
    const org = await orgModel.createOrganization({ name: 'Sweep Co', ownerUserId: ownerId });
    await orgModel.addManualCredit({
      amountMicroUsd: usd(params.orgWalletUsd),
      amountToman: Math.round(params.orgWalletUsd * 5000),
      createdByUserId: ownerId,
      fxRateTomanPerUsd: 5000,
      orgId: org.id,
    });

    const members = [];
    for (const spec of params.members) {
      const invite = await orgModel.createInvite({
        identifierType: 'email',
        identifierValue: spec.email,
        invitedByUserId: ownerId,
        orgId: org.id,
        role: 'member',
      });
      const { member } = await orgModel.acceptInvite({
        email: spec.email,
        token: invite.token,
        userId: spec.userId,
      });
      await orgModel.allocateMemberCredit({
        createdByUserId: ownerId,
        orgId: org.id,
        orgMemberId: member.id,
        period: 'daily',
        periodAmountMicroUsd: usd(spec.capUsd),
      });
      // `undefined` = live managed key; `null` = budget with no key at all.
      const keyId = spec.keyId === undefined ? `or-key-${spec.userId}` : spec.keyId;
      await serverDB
        .update(memberBudgets)
        .set({ openrouterKeyCiphertext: keyId ? 'cipher' : null, openrouterKeyId: keyId })
        .where(eq(memberBudgets.orgMemberId, member.id));
      members.push(member);
    }
    return { members, org };
  };

  const rowFor = <T extends { memberId: string }>(rows: T[], memberId: string): T =>
    rows.find((r) => r.memberId === memberId)!;

  const mockKeyService = (overrides: Partial<AicoOpenRouterKeyService> = {}) =>
    ({
      peekMemberRemaining: vi.fn(async () => ({
        keyId: 'or-key',
        remainingMicroUsd: usd(4),
        usageMicroUsd: usd(1),
      })),
      reclaimMemberKey: vi.fn(async () => ({
        remainingMicroUsd: usd(4),
        usageMicroUsd: usd(1),
      })),
      ...overrides,
    }) as unknown as AicoOpenRouterKeyService;

  describe('previewOrgBudgetSweep', () => {
    it('reports the OpenRouter figure without disabling a single key', async () => {
      const { org } = await setupOrg({
        members: [
          { capUsd: 5, email: 'member-a@example.com', userId: memberAId },
          { capUsd: 5, email: 'member-b@example.com', userId: memberBId },
        ],
        orgWalletUsd: 20,
      });
      const keyService = mockKeyService();

      const preview = await previewOrgBudgetSweep({ db: serverDB, keyService, orgId: org.id });

      // The owner is on the roster too, listed with no budget and nothing to reclaim.
      expect(preview.memberCount).toBe(3);
      expect(preview.rows.filter((r) => r.skipReason === 'no-budget')).toHaveLength(1);
      expect(preview.totalReclaimMicroUsd).toBe(usd(8));
      expect(preview.currentOrgBalanceMicroUsd).toBe(usd(10));
      expect(preview.projectedOrgBalanceMicroUsd).toBe(usd(18));
      expect(
        preview.rows.filter((r) => !r.skipReason).every((r) => r.estimateSource === 'openrouter'),
      ).toBe(true);
      // A cancelled preview must leave the roster able to keep chatting.
      expect(keyService.reclaimMemberKey).not.toHaveBeenCalled();
    });

    it('falls back to wallet math for a budget with no managed key', async () => {
      const { members, org } = await setupOrg({
        members: [{ capUsd: 5, email: 'member-a@example.com', keyId: null, userId: memberAId }],
        orgWalletUsd: 20,
      });

      const preview = await previewOrgBudgetSweep({
        db: serverDB,
        keyService: mockKeyService(),
        orgId: org.id,
      });

      const row = rowFor(preview.rows, members[0].id);
      expect(row.estimateSource).toBe('wallet-only');
      expect(row.reclaimMicroUsd).toBe(usd(5));
    });

    it('degrades to a labelled estimate when OpenRouter is unreachable', async () => {
      const { members, org } = await setupOrg({
        members: [{ capUsd: 5, email: 'member-a@example.com', userId: memberAId }],
        orgWalletUsd: 20,
      });
      const keyService = mockKeyService({
        peekMemberRemaining: vi.fn(async () => {
          throw new Error('OPENROUTER_DOWN');
        }),
      });

      const preview = await previewOrgBudgetSweep({ db: serverDB, keyService, orgId: org.id });

      const row = rowFor(preview.rows, members[0].id);
      expect(row.estimateSource).toBe('wallet-fallback');
      expect(row.reclaimMicroUsd).toBe(usd(5));
    });

    it('marks an already-settled budget as skipped with nothing to reclaim', async () => {
      const { members, org } = await setupOrg({
        members: [{ capUsd: 5, email: 'member-a@example.com', userId: memberAId }],
        orgWalletUsd: 20,
      });
      await orgModel.reclaimMemberRemainingCredit({
        orgId: org.id,
        orgMemberId: members[0].id,
        remainingMicroUsd: usd(5),
      });

      const preview = await previewOrgBudgetSweep({
        db: serverDB,
        keyService: mockKeyService(),
        orgId: org.id,
      });

      expect(rowFor(preview.rows, members[0].id).skipReason).toBe('already-settled');
      expect(preview.totalReclaimMicroUsd).toBe(0);
      // Both the settled member and the budget-less owner count as skipped.
      expect(preview.skippedCount).toBe(2);
    });
  });

  describe('executeOrgBudgetSweep', () => {
    it('returns every member allowance to the org wallet and zeroes their budgets', async () => {
      const { members, org } = await setupOrg({
        members: [
          { capUsd: 5, email: 'member-a@example.com', userId: memberAId },
          { capUsd: 5, email: 'member-b@example.com', userId: memberBId },
        ],
        orgWalletUsd: 20,
      });

      const result = await executeOrgBudgetSweep({
        actorUserId: ownerId,
        batchId: 'sweep-batch-1',
        db: serverDB,
        keyService: mockKeyService(),
        orgId: org.id,
      });

      expect(result.reclaimedCount).toBe(2);
      expect(result.deferredCount).toBe(0);
      expect(result.totalReclaimedMicroUsd).toBe(usd(8));
      // $20 funded − $10 allocated + $8 reclaimed.
      expect(result.orgBalanceMicroUsd).toBe(usd(18));

      for (const member of members) {
        const budget = await orgModel.getMemberBudget(member.id);
        expect(Number(budget!.periodAmountMicroUsd)).toBe(0);
        expect(Number(budget!.reservedMicroUsd)).toBe(0);
        expect(budget!.isActive).toBe(false);
        expect(budget!.renewalStatus).toBe('settled');
      }
    });

    it('only appends to the ledger — no history is rewritten', async () => {
      const { org } = await setupOrg({
        members: [{ capUsd: 5, email: 'member-a@example.com', userId: memberAId }],
        orgWalletUsd: 20,
      });
      const before = await serverDB.query.walletTransactions.findMany({
        where: eq(walletTransactions.orgId, org.id),
      });

      await executeOrgBudgetSweep({
        actorUserId: ownerId,
        batchId: 'sweep-batch-1',
        db: serverDB,
        keyService: mockKeyService(),
        orgId: org.id,
      });

      const after = await serverDB.query.walletTransactions.findMany({
        where: eq(walletTransactions.orgId, org.id),
      });
      expect(after).toHaveLength(before.length + 1);
      // Every pre-existing row survives byte-for-byte.
      for (const row of before) {
        expect(after.find((r) => r.id === row.id)).toEqual(row);
      }
      const added = after.find((r) => !before.some((b) => b.id === r.id))!;
      expect(added.type).toBe('reclaim');
      expect(added.description).toContain('sweep-batch-1');
    });

    it('credits nothing on a second sweep', async () => {
      const { org } = await setupOrg({
        members: [{ capUsd: 5, email: 'member-a@example.com', userId: memberAId }],
        orgWalletUsd: 20,
      });
      const args = {
        actorUserId: ownerId,
        db: serverDB,
        keyService: mockKeyService(),
        orgId: org.id,
      };

      const first = await executeOrgBudgetSweep({ ...args, batchId: 'sweep-1' });
      const second = await executeOrgBudgetSweep({ ...args, batchId: 'sweep-2' });

      expect(first.totalReclaimedMicroUsd).toBe(usd(4));
      expect(second.totalReclaimedMicroUsd).toBe(0);
      expect(second.reclaimedCount).toBe(0);
      expect(second.orgBalanceMicroUsd).toBe(first.orgBalanceMicroUsd);
    });

    it('defers to the key outbox when OpenRouter fails, rather than guessing an amount', async () => {
      const { members, org } = await setupOrg({
        members: [{ capUsd: 5, email: 'member-a@example.com', userId: memberAId }],
        orgWalletUsd: 20,
      });
      const keyService = mockKeyService({
        reclaimMemberKey: vi.fn(async () => {
          throw new Error('OPENROUTER_DOWN');
        }),
      });

      const result = await executeOrgBudgetSweep({
        actorUserId: ownerId,
        batchId: 'sweep-batch-1',
        db: serverDB,
        keyService,
        orgId: org.id,
      });

      expect(result.deferredCount).toBe(1);
      expect(result.totalReclaimedMicroUsd).toBe(0);
      expect(rowFor(result.rows, members[0].id).error).toBe('OPENROUTER_DOWN');

      const outbox = await serverDB.query.aicoKeyOutbox.findMany();
      expect(outbox).toHaveLength(1);
      expect(outbox[0].action).toBe('reclaim_member');
      expect(outbox[0].orgMemberId).toBe(members[0].id);
      expect(outbox[0].status).toBe('pending');

      // The budget is untouched until the outbox settles it.
      const budget = await orgModel.getMemberBudget(members[0].id);
      expect(budget!.renewalStatus).not.toBe('settled');
    });

    it('reclaims wallet-side for a budget whose managed key is already gone', async () => {
      const { org } = await setupOrg({
        members: [{ capUsd: 5, email: 'member-a@example.com', keyId: null, userId: memberAId }],
        orgWalletUsd: 20,
      });
      const keyService = mockKeyService();

      const result = await executeOrgBudgetSweep({
        actorUserId: ownerId,
        batchId: 'sweep-batch-1',
        db: serverDB,
        keyService,
        orgId: org.id,
      });

      expect(keyService.reclaimMemberKey).not.toHaveBeenCalled();
      expect(result.totalReclaimedMicroUsd).toBe(usd(5));
      expect(result.orgBalanceMicroUsd).toBe(usd(20));
    });

    it('stops the daily charges: swept budgets are no longer due for renewal', async () => {
      const { members, org } = await setupOrg({
        members: [{ capUsd: 5, email: 'member-a@example.com', userId: memberAId }],
        orgWalletUsd: 20,
      });
      await serverDB
        .update(memberBudgets)
        .set({ nextRenewalAt: new Date(Date.now() - 60_000) })
        .where(eq(memberBudgets.orgMemberId, members[0].id));

      await executeOrgBudgetSweep({
        actorUserId: ownerId,
        batchId: 'sweep-batch-1',
        db: serverDB,
        keyService: mockKeyService(),
        orgId: org.id,
      });

      const balanceAfterSweep = (await orgModel.getById(org.id))!.walletBalanceMicroUsd;
      const renewals = await processDueRenewals(serverDB, { keyService: mockKeyService() });

      expect(renewals).toHaveLength(0);
      expect((await orgModel.getById(org.id))!.walletBalanceMicroUsd).toBe(balanceAfterSweep);
    });
  });
});
