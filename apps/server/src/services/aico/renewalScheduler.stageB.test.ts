/**
 * Stage B of the 2026-10 wallet/renewal re-audit: a renewal that cannot get
 * stuck (R2, R3, R4, R9, R10, R11, FIN-028, N5, N6).
 */
// @vitest-environment node
import type { LobeChatDatabase } from '@lobechat/database';
import { getTestDB } from '@lobechat/database/test-utils';
import { and, eq } from 'drizzle-orm';
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
import { aicoEnv } from '@/envs/aico';
import { processDueRenewals, processKeyOutbox } from '@/server/services/aico/renewalScheduler';
import type { AicoOpenRouterKeyService } from '@/server/services/openrouter/keyService';

const usd = (n: number) => Math.round(n * 1_000_000);
const MIN = 60_000;
const ownerId = 'aico-renewal-b-owner';
const memberUserId = 'aico-renewal-b-member';

describe('renewal scheduler — stage B', () => {
  let db: LobeChatDatabase;
  let orgModel: OrganizationModel;

  const wipe = async () => {
    await db.delete(aicoKeyOutbox);
    await db.delete(aicoRenewalBatches);
    await db.delete(walletTransactions);
    await db.delete(memberBudgets);
    await db.delete(organizationTeamMembers);
    await db.delete(organizationTeams);
    await db.delete(organizationMembers);
    await db.delete(organizations);
    await db.delete(users);
  };

  beforeEach(async () => {
    db = await getTestDB();
    orgModel = new OrganizationModel(db);
    await wipe();
    await db.insert(users).values([
      { email: 'owner-rb@example.com', id: ownerId },
      { email: 'member-rb@example.com', id: memberUserId },
    ]);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await wipe();
  });

  /** One member on a $5 daily cap, fully spent, whose org wallet is empty. */
  const setup = async () => {
    const org = await orgModel.createOrganization({ name: 'Renew B Co', ownerUserId: ownerId });
    await orgModel.addManualCredit({
      amountMicroUsd: usd(5),
      amountToman: 25_000,
      createdByUserId: ownerId,
      fxRateTomanPerUsd: 5000,
      orgId: org.id,
    });
    const invite = await orgModel.createInvite({
      identifierType: 'email',
      identifierValue: 'member-rb@example.com',
      invitedByUserId: ownerId,
      orgId: org.id,
      role: 'member',
    });
    const { member } = await orgModel.acceptInvite({
      email: 'member-rb@example.com',
      token: invite.token,
      userId: memberUserId,
    });
    await orgModel.allocateMemberCredit({
      createdByUserId: ownerId,
      orgId: org.id,
      orgMemberId: member.id,
      period: 'daily',
      periodAmountMicroUsd: usd(5),
    });
    await db
      .update(memberBudgets)
      .set({
        nextRenewalAt: new Date(Date.now() - 60_000),
        openrouterKeyCiphertext: 'cipher',
        openrouterKeyId: 'mock-key',
        settledUsageMicroUsd: usd(5),
      })
      .where(eq(memberBudgets.orgMemberId, member.id));
    return { member, org };
  };

  const topUp = (orgId: string, amountUsd = 10) =>
    orgModel.addManualCredit({
      amountMicroUsd: usd(amountUsd),
      amountToman: amountUsd * 5000,
      createdByUserId: ownerId,
      fxRateTomanPerUsd: 5000,
      orgId,
    });

  const keyService = (overrides: Record<string, unknown> = {}) => {
    const service = {
      disableMemberKey: vi.fn(async () => null),
      ensureMemberKey: vi.fn(async () => ({ created: false, keyId: 'mock-key' })),
      settleMemberPeriod: vi.fn(async () => ({
        remainingMicroUsd: 0,
        usageMicroUsd: usd(5),
      })),
      ...overrides,
    };
    return service as unknown as AicoOpenRouterKeyService & typeof service;
  };

  const batchesOf = (orgId: string) =>
    db.query.aicoRenewalBatches.findMany({ where: eq(aicoRenewalBatches.orgId, orgId) });

  const disableRows = (orgMemberId: string) =>
    db.query.aicoKeyOutbox.findMany({
      where: and(
        eq(aicoKeyOutbox.orgMemberId, orgMemberId),
        eq(aicoKeyOutbox.action, 'disable_member_key'),
      ),
    });

  describe('R2: org deletion', () => {
    it('is not blocked by a finished (funded) batch', async () => {
      const { org } = await setup();
      await db.insert(aicoRenewalBatches).values({
        batchKey: `${org.id}:2026-01-01T00:00:00.000Z`,
        orgId: org.id,
        status: 'funded',
      });

      await expect(
        orgModel.softDeleteOrganization({ confirmName: org.name, orgId: org.id }),
      ).resolves.toBeDefined();
    });

    it('is still blocked by a batch that is mid-flight', async () => {
      const { org } = await setup();
      await db.insert(aicoRenewalBatches).values({
        batchKey: `${org.id}:2026-01-01T00:00:00.000Z`,
        orgId: org.id,
        status: 'pending',
      });

      await expect(
        orgModel.softDeleteOrganization({ confirmName: org.name, orgId: org.id }),
      ).rejects.toThrow('ORG_HAS_PENDING_RENEWAL');
    });
  });

  describe('FIN-028 / R11: a failed batch is retried in place, with backoff', () => {
    it('keeps the batch row, funds it after a top-up, and skips a retry inside the backoff', async () => {
      const { member, org } = await setup();
      const service = keyService();
      const t0 = new Date();

      const first = await processDueRenewals(db, { keyService: service, now: t0 });
      expect(first[0].status).toBe('failed');
      const [failed] = await batchesOf(org.id);
      await topUp(org.id);

      const early = await processDueRenewals(db, {
        keyService: service,
        now: new Date(t0.getTime() + 5 * MIN),
      });
      expect(early[0].status).toBe('skipped');
      expect((await orgModel.getMemberBudget(member.id))?.renewalStatus).toBe('renewal_failed');

      const later = await processDueRenewals(db, {
        keyService: service,
        now: new Date(t0.getTime() + 16 * MIN),
      });
      expect(later[0].status).toBe('funded');

      const batches = await batchesOf(org.id);
      expect(batches).toHaveLength(1);
      expect(batches[0].id).toBe(failed.id);
      expect(batches[0].status).toBe('funded');
      const renewalTx = await db.query.walletTransactions.findFirst({
        where: and(
          eq(walletTransactions.orgMemberId, member.id),
          eq(walletTransactions.type, 'period_renewal'),
        ),
      });
      expect(renewalTx?.renewalBatchId).toBe(failed.id);
    });

    it('queues one disable row for three failed runs, and freezes the key once', async () => {
      const { member } = await setup();
      const service = keyService();
      const t0 = new Date();

      for (const minutes of [0, 16, 32]) {
        const [result] = await processDueRenewals(db, {
          keyService: service,
          now: new Date(t0.getTime() + minutes * MIN),
        });
        expect(result.status).toBe('failed');
      }

      expect(await disableRows(member.id)).toHaveLength(1);
      expect(service.disableMemberKey).toHaveBeenCalledTimes(1);
    });

    it('a freshly inserted batch is funded on the first run, with the lease as its updated_at', async () => {
      const { org } = await setup();
      await topUp(org.id);
      const now = new Date();

      const [result] = await processDueRenewals(db, { keyService: keyService(), now });

      expect(result.status).toBe('funded');
      const [batch] = await batchesOf(org.id);
      expect(batch.updatedAt.getTime()).toBe(now.getTime());
    });
  });

  describe('R4: a batch left pending by a crashed worker', () => {
    /** The state a worker dying right after claiming leaves behind. */
    const crashedWorker = async (orgId: string, memberId: string, t0: Date) => {
      await processDueRenewals(db, { keyService: keyService(), now: t0 });
      await db
        .update(aicoRenewalBatches)
        .set({ status: 'pending', updatedAt: t0 })
        .where(eq(aicoRenewalBatches.orgId, orgId));
      await db
        .update(memberBudgets)
        .set({ isActive: true, renewalStatus: 'renewal_pending' })
        .where(eq(memberBudgets.orgMemberId, memberId));
      await topUp(orgId);
    };

    it('is re-claimed and funded once it is 30 minutes stale', async () => {
      const { member, org } = await setup();
      const t0 = new Date();
      await crashedWorker(org.id, member.id, t0);

      const [result] = await processDueRenewals(db, {
        keyService: keyService(),
        now: new Date(t0.getTime() + 31 * MIN),
      });

      expect(result.status).toBe('funded');
      expect((await orgModel.getMemberBudget(member.id))?.renewalStatus).toBe('active');
      expect(await batchesOf(org.id)).toHaveLength(1);
    });

    it('is left alone while it is only five minutes old', async () => {
      const { member, org } = await setup();
      const t0 = new Date();
      await crashedWorker(org.id, member.id, t0);

      const [result] = await processDueRenewals(db, {
        keyService: keyService(),
        now: new Date(t0.getTime() + 5 * MIN),
      });

      expect(result.status).toBe('skipped');
      expect((await batchesOf(org.id))[0].status).toBe('pending');
    });
  });

  describe('lease: a worker that lost its claim funds nothing', () => {
    it('re-claimed by a second worker, the first one cannot debit the org again', async () => {
      const { member, org } = await setup();
      await topUp(org.id);
      const t0 = new Date();
      const later = new Date(t0.getTime() + 31 * MIN);
      const second = keyService();
      let rival: Promise<unknown> | undefined;
      // Worker A is slow in settlement; its lease goes stale and B takes over.
      const first = keyService({
        settleMemberPeriod: vi.fn(async () => {
          rival ??= processDueRenewals(db, { keyService: second, now: later });
          await rival;
          return { remainingMicroUsd: 0, usageMicroUsd: usd(5) };
        }),
      });

      const [a] = await processDueRenewals(db, { keyService: first, now: t0 });

      expect(a.status).toBe('skipped');
      const [batch] = await batchesOf(org.id);
      expect(batch.status).toBe('funded');
      // $10 topped up, $5 debited exactly once.
      expect(Number((await orgModel.getById(org.id))?.walletBalanceMicroUsd)).toBe(usd(5));
      const renewals = await db.query.walletTransactions.findMany({
        where: and(
          eq(walletTransactions.orgMemberId, member.id),
          eq(walletTransactions.type, 'period_renewal'),
        ),
      });
      expect(renewals).toHaveLength(1);
    });
  });

  describe('R3: a stale boundary cannot freeze the org', () => {
    it('renews a budget whose old-format batch key is already funded', async () => {
      const { member, org } = await setup();
      await topUp(org.id);
      const budget = await orgModel.getMemberBudget(member.id);
      await db.insert(aicoRenewalBatches).values({
        batchKey: `${org.id}:${budget!.nextRenewalAt!.toISOString()}`,
        orgId: org.id,
        status: 'funded',
      });

      const [result] = await processDueRenewals(db, { keyService: keyService() });

      expect(result.status).toBe('funded');
      expect(Number((await orgModel.getById(org.id))?.walletBalanceMicroUsd)).toBe(usd(5));
    });

    it('AICO_FIX_S2_RENEWAL_BATCH=0 keeps the unfingerprinted key and the immediate retry', async () => {
      const flags = aicoEnv as { AICO_FIX_S2_RENEWAL_BATCH: boolean };
      flags.AICO_FIX_S2_RENEWAL_BATCH = false;
      try {
        const { org } = await setup();
        const service = keyService();
        await processDueRenewals(db, { keyService: service });
        const [batch] = await batchesOf(org.id);
        expect(batch.batchKey).toMatch(/^[^:]+:[^:]+:[^:]+:[^:]+$/);
        expect(batch.batchKey.split('.')).toHaveLength(2);
        await topUp(org.id);

        const [retry] = await processDueRenewals(db, { keyService: service });

        expect(retry.status).toBe('funded');
      } finally {
        flags.AICO_FIX_S2_RENEWAL_BATCH = true;
      }
    });
  });

  describe('R9: a stale disable row does not freeze a renewed key', () => {
    it('skips a renewal-written disable once the budget is funded again', async () => {
      const { member, org } = await setup();
      const service = keyService();
      const t0 = new Date();
      await processDueRenewals(db, { keyService: service, now: t0 });
      await topUp(org.id);
      await processDueRenewals(db, {
        keyService: service,
        now: new Date(t0.getTime() + 16 * MIN),
      });
      service.disableMemberKey.mockClear();

      const result = await processKeyOutbox(db, {
        keyService: service,
        now: new Date(t0.getTime() + 17 * MIN),
      });

      expect(result.succeeded).toBe(1);
      expect(service.disableMemberKey).not.toHaveBeenCalled();
      expect((await orgModel.getMemberBudget(member.id))?.renewalStatus).toBe('active');
    });

    it('still runs a removal disable, which carries no batch key', async () => {
      const { member, org } = await setup();
      await db.insert(aicoKeyOutbox).values({
        action: 'disable_member_key',
        nextAttemptAt: new Date(Date.now() - 1000),
        orgId: org.id,
        orgMemberId: member.id,
        status: 'pending',
      });
      const service = keyService();

      await processKeyOutbox(db, { keyService: service });

      expect(service.disableMemberKey).toHaveBeenCalledWith(member.id);
    });
  });

  describe('R10: the key sync after funding survives a crash', () => {
    it('leaves a delayed sync_member_key row that unfreezes the key later', async () => {
      const { member, org } = await setup();
      await topUp(org.id);
      const t0 = new Date();
      const broken = keyService({
        ensureMemberKey: vi.fn(async () => {
          throw new Error('CVC down');
        }),
      });
      await processDueRenewals(db, { keyService: broken, now: t0 });

      const rows = await db.query.aicoKeyOutbox.findMany({
        where: eq(aicoKeyOutbox.action, 'sync_member_key'),
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].orgMemberId).toBe(member.id);
      expect(rows[0].nextAttemptAt.getTime()).toBe(t0.getTime() + 5 * MIN);

      const healthy = keyService();
      // Only the failed sync's own disable row is due yet; the backstop is not.
      await processKeyOutbox(db, {
        keyService: healthy,
        now: new Date(t0.getTime() + 1 * MIN),
      });
      expect(healthy.ensureMemberKey).not.toHaveBeenCalled();

      await processKeyOutbox(db, {
        keyService: healthy,
        now: new Date(t0.getTime() + 6 * MIN),
      });
      expect(healthy.ensureMemberKey).toHaveBeenCalledWith(member.id);
    });
  });

  describe('N5: only active organizations renew', () => {
    it('does not renew, debit or freeze a suspended organization', async () => {
      const { member, org } = await setup();
      await topUp(org.id);
      await db
        .update(organizations)
        .set({ status: 'suspended' })
        .where(eq(organizations.id, org.id));
      const service = keyService();

      const results = await processDueRenewals(db, { keyService: service });

      expect(results).toHaveLength(0);
      expect(service.disableMemberKey).not.toHaveBeenCalled();
      expect(Number((await orgModel.getById(org.id))?.walletBalanceMicroUsd)).toBe(usd(10));
      expect((await orgModel.getMemberBudget(member.id))?.renewalStatus).toBe('active');
    });
  });

  describe('N6: an outbox row stuck in processing', () => {
    const stuckRow = async (orgId: string, memberId: string, updatedAt: Date, attempts = 1) => {
      const [row] = await db
        .insert(aicoKeyOutbox)
        .values({
          action: 'disable_member_key',
          attempts,
          nextAttemptAt: new Date(Date.now() - 3_600_000),
          orgId,
          orgMemberId: memberId,
          status: 'processing',
          updatedAt,
        })
        .returning();
      return row;
    };

    it('is picked up again after 15 minutes', async () => {
      const { member, org } = await setup();
      const now = new Date();
      const row = await stuckRow(org.id, member.id, new Date(now.getTime() - 20 * MIN));
      const service = keyService();

      await processKeyOutbox(db, { keyService: service, now });

      expect(service.disableMemberKey).toHaveBeenCalledWith(member.id);
      const after = await db.query.aicoKeyOutbox.findFirst({ where: eq(aicoKeyOutbox.id, row.id) });
      expect(after?.status).toBe('succeeded');
    });

    it('is left alone while a worker may still be running it', async () => {
      const { member, org } = await setup();
      const now = new Date();
      await stuckRow(org.id, member.id, new Date(now.getTime() - 5 * MIN));
      const service = keyService();

      const result = await processKeyOutbox(db, { keyService: service, now });

      expect(result.processed).toBe(0);
      expect(service.disableMemberKey).not.toHaveBeenCalled();
    });

    it('is not retried forever once its attempts are used up', async () => {
      const { member, org } = await setup();
      const now = new Date();
      await stuckRow(org.id, member.id, new Date(now.getTime() - 20 * MIN), 12);

      const result = await processKeyOutbox(db, { keyService: keyService(), now });

      expect(result.processed).toBe(0);
    });
  });
});
