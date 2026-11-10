// @vitest-environment node
import type { LobeChatDatabase } from '@lobechat/database';
import { getTestDB } from '@lobechat/database/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OrganizationModel } from '@/database/models/organization';
import { users } from '@/database/schemas';
import {
  aicoKeyOutbox,
  type AicoReconciliationCheck,
  aicoReconciliationRuns,
  aicoRenewalBatches,
  memberBudgets,
  organizationMembers,
  organizations,
  organizationTeamMembers,
  organizationTeams,
  userWallets,
  walletTransactions,
} from '@/database/schemas/aicoOrganization';
import { aicoEnv } from '@/envs/aico';
import type { ManagedProviderClient } from '@/server/services/managedProvider';

import { runReconciliation, splitAtCutoff } from './reconciliation';

vi.hoisted(() => {
  process.env.KEY_VAULTS_SECRET ||= 'LA7n9k3JdEcbSgml2sxfw+4TV1AzaaFU5+R176aQz4s=';
});

/**
 * RB — reconcile can be told to check history only from a cutoff on. Every row
 * below has an explicit `createdAt`: the cutoff compares timestamps, and a row
 * stamped "now" would always land after it.
 */
const userId = 'recon-cutoff-user';
const CUTOFF = '2026-10-05T00:00:00Z';
const day = (d: number) => new Date(Date.UTC(2026, 9, d));
const usd = (n: number) => n * 1_000_000;

const provider = {
  capabilities: {
    nativePeriodicLimits: false,
    readKeyBySecret: true,
    revoke: true,
    updateLimit: false,
  },
  createKey: vi.fn(),
  getAccountBalanceUsd: vi.fn(async () => 20),
  getKey: vi.fn(async () => ({ limitRemaining: 0 })),
  providerId: 'cheapvibecode',
  resizeKey: vi.fn(),
  updateKey: vi.fn(),
} as unknown as ManagedProviderClient;
const deps = { listOpenRouterKeys: async () => null, managed: provider, sleep: async () => {} };

const clean = async (db: LobeChatDatabase) => {
  await db.delete(aicoKeyOutbox);
  await db.delete(aicoRenewalBatches);
  await db.delete(aicoReconciliationRuns);
  await db.delete(walletTransactions);
  await db.delete(memberBudgets);
  await db.delete(organizationTeamMembers);
  await db.delete(organizationTeams);
  await db.delete(organizationMembers);
  await db.delete(organizations);
  await db.delete(userWallets);
  await db.delete(users);
};

interface Row {
  after: number | null;
  amount: number;
  at: Date;
  before: number | null;
}

const checkOf = async (db: LobeChatDatabase, id: string): Promise<AicoReconciliationCheck> => {
  const run = await runReconciliation(db, { trigger: 'cron' }, deps);
  return run.checks.find((c) => c.id === id)!;
};

const withCutoff = async <T>(value: string | undefined, fn: () => Promise<T>): Promise<T> => {
  const env = aicoEnv as { AICO_RECONCILE_LEDGER_SINCE?: string };
  const previous = env.AICO_RECONCILE_LEDGER_SINCE;
  env.AICO_RECONCILE_LEDGER_SINCE = value;
  try {
    return await fn();
  } finally {
    env.AICO_RECONCILE_LEDGER_SINCE = previous;
  }
};

describe('reconcile history cutoff (RB)', () => {
  let db: LobeChatDatabase;
  let orgId: string;

  beforeEach(async () => {
    db = await getTestDB();
    await clean(db);
    await db.insert(users).values({ email: 'recon-cutoff@example.com', id: userId });
    orgId = (
      await new OrganizationModel(db).createOrganization({ name: 'Cutoff Co', ownerUserId: userId })
    ).id;
  });

  afterEach(() => clean(db));

  const seedWallet = async (balance: number, rows: Row[]) => {
    await db.insert(userWallets).values({ balanceMicroUsd: balance, userId });
    await db.insert(walletTransactions).values(
      rows.map((r) => ({
        amountMicroUsd: r.amount,
        amountToman: 0,
        balanceAfterMicroUsd: r.after,
        balanceBeforeMicroUsd: r.before,
        createdAt: r.at,
        createdByUserId: userId,
        description: 'row',
        type: 'adjustment' as const,
        userId,
      })),
    );
  };

  const seedOrg = async (balance: number, rows: Row[]) => {
    await db.update(organizations).set({ walletBalanceMicroUsd: balance });
    await db.insert(walletTransactions).values(
      rows.map((r) => ({
        amountMicroUsd: r.amount,
        amountToman: 0,
        balanceAfterMicroUsd: r.after,
        balanceBeforeMicroUsd: r.before,
        createdAt: r.at,
        createdByUserId: userId,
        description: 'row',
        orgId,
        type: 'adjustment' as const,
      })),
    );
  };

  // Day 1 top-up to $5; day 2 a row that starts at $9 (a break) and ends at $8;
  // day 10 spends $1 from $8.
  const brokenBeforeCutoff = (): Row[] => [
    { after: usd(5), amount: usd(5), at: day(1), before: 0 },
    { after: usd(8), amount: -usd(1), at: day(2), before: usd(9) },
    { after: usd(7), amount: -usd(1), at: day(10), before: usd(8) },
  ];

  describe('wallet_ledger', () => {
    it('reports an old break without the variable and ignores it with one', async () => {
      await seedWallet(usd(7), brokenBeforeCutoff());

      const all = await withCutoff(undefined, () => checkOf(db, 'wallet_ledger'));
      expect(all.status).toBe('critical');
      expect(all.values).not.toHaveProperty('historyCutoff');

      const cut = await withCutoff(CUTOFF, () => checkOf(db, 'wallet_ledger'));
      expect(cut).toMatchObject({
        details: [],
        status: 'ok',
        values: { historyCutoff: '2026-10-05T00:00:00.000Z', rowsBeforeCutoff: 2 },
      });
    });

    it('still reports a break after the cutoff', async () => {
      await seedWallet(usd(5), [
        { after: usd(8), amount: usd(8), at: day(2), before: 0 },
        { after: usd(5), amount: -usd(1), at: day(10), before: usd(6) },
      ]);

      const cut = await withCutoff(CUTOFF, () => checkOf(db, 'wallet_ledger'));

      expect(cut.status).toBe('critical');
      expect(cut.details.join('\n')).toContain('previous row ended at $8.0000');
    });

    it('reports a break exactly at the cutoff instant', async () => {
      await seedWallet(usd(9), [
        { after: usd(8), amount: usd(8), at: day(2), before: 0 },
        { after: usd(7), amount: usd(1), at: new Date(CUTOFF), before: usd(6) },
      ]);

      const cut = await withCutoff(CUTOFF, () => checkOf(db, 'wallet_ledger'));

      expect(cut.status).toBe('critical');
      expect(cut.details).toEqual([
        expect.stringContaining('starts at $6.0000, previous row ended at $8.0000'),
      ]);
    });

    it('accepts history that is unbalanced before the cutoff and consistent after it', async () => {
      // The day-2 row records +$3 but moved the balance by +$2.
      const rows: Row[] = [
        { after: usd(5), amount: usd(5), at: day(1), before: 0 },
        { after: usd(7), amount: usd(3), at: day(2), before: usd(5) },
        { after: usd(6), amount: -usd(1), at: day(10), before: usd(7) },
      ];
      await seedWallet(usd(6), rows);

      expect((await withCutoff(undefined, () => checkOf(db, 'wallet_ledger'))).status).toBe(
        'critical',
      );
      expect((await withCutoff(CUTOFF, () => checkOf(db, 'wallet_ledger'))).status).toBe('ok');
    });

    it('falls back to the sum of old amounts when no old row has a balance', async () => {
      const rows: Row[] = [
        { after: null, amount: usd(5), at: day(1), before: null },
        { after: null, amount: -usd(1), at: day(10), before: null },
      ];
      await seedWallet(usd(4), rows);
      expect((await withCutoff(CUTOFF, () => checkOf(db, 'wallet_ledger'))).status).toBe('ok');

      await db.update(userWallets).set({ balanceMicroUsd: usd(3) });
      const wrong = await withCutoff(CUTOFF, () => checkOf(db, 'wallet_ledger'));
      expect(wrong.status).toBe('critical');
    });
  });

  describe('org_ledger', () => {
    it('reports an old break without the variable and ignores it with one', async () => {
      await seedOrg(usd(7), brokenBeforeCutoff());

      expect((await withCutoff(undefined, () => checkOf(db, 'org_ledger'))).status).toBe(
        'critical',
      );
      const cut = await withCutoff(CUTOFF, () => checkOf(db, 'org_ledger'));
      expect(cut).toMatchObject({
        details: [],
        status: 'ok',
        values: { historyCutoff: '2026-10-05T00:00:00.000Z', rowsBeforeCutoff: 2 },
      });
    });

    it('still reports a break after the cutoff', async () => {
      await seedOrg(usd(7), [
        { after: usd(8), amount: usd(8), at: day(2), before: 0 },
        { after: usd(7), amount: -usd(1), at: day(10), before: usd(6) },
      ]);

      const cut = await withCutoff(CUTOFF, () => checkOf(db, 'org_ledger'));

      expect(cut.status).toBe('critical');
      expect(cut.details.join('\n')).toContain('previous row ended at $8.0000');
    });

    it('reports a break exactly at the cutoff instant', async () => {
      await seedOrg(usd(7), [
        { after: usd(8), amount: usd(8), at: day(2), before: 0 },
        { after: usd(7), amount: -usd(1), at: new Date(CUTOFF), before: usd(6) },
      ]);

      const cut = await withCutoff(CUTOFF, () => checkOf(db, 'org_ledger'));

      expect(cut.status).toBe('critical');
    });

    it('still compares the balance with the last row when every row is older than the cutoff', async () => {
      await seedOrg(usd(4), [{ after: usd(5), amount: usd(5), at: day(1), before: 0 }]);

      const cut = await withCutoff(CUTOFF, () => checkOf(db, 'org_ledger'));

      expect(cut.status).toBe('critical');
      expect(cut.details[0]).toContain('last transaction ended at $5.0000');
    });
  });

  describe('splitAtCutoff', () => {
    const row = (
      id: string,
      at: Date,
      before: number | null,
      after: number | null,
      amount = 0,
    ) => ({
      amountMicroUsd: amount,
      balanceAfterMicroUsd: after,
      balanceBeforeMicroUsd: before,
      createdAt: at,
      id,
    });

    it('checks everything without a cutoff', () => {
      const rows = [row('a', day(1), 0, 5, 5)];
      expect(splitAtCutoff(rows, null)).toEqual({
        anchor: null,
        before: 0,
        rows,
        startBalance: 0,
      });
    });

    it('anchors at the last old row that has a balance and adds later old rows that do not', () => {
      const rows = [
        row('a', day(1), 0, 5, 5),
        row('b', day(2), 5, null, 2),
        row('c', day(10), null, null, -1),
      ];
      const split = splitAtCutoff(rows, new Date(CUTOFF));
      expect(split.anchor).toBe(5);
      expect(split.startBalance).toBe(7);
      expect(split.rows.map((r) => r.id)).toEqual(['c']);
    });
  });

  describe('outbox status superseded (OBX)', () => {
    it('is not reported by key hygiene', async () => {
      await db.insert(aicoKeyOutbox).values({
        action: 'disable_member_key',
        attempts: 12,
        nextAttemptAt: day(1),
        orgId,
        status: 'superseded',
      });

      const hygiene = await checkOf(db, 'key_hygiene');

      expect(hygiene.details.filter((d) => d.includes('outbox'))).toEqual([]);
    });

    it('does report the same row while it is still failed', async () => {
      await db.insert(aicoKeyOutbox).values({
        action: 'disable_member_key',
        attempts: 12,
        nextAttemptAt: day(1),
        orgId,
        status: 'failed',
      });

      const hygiene = await checkOf(db, 'key_hygiene');

      expect(hygiene.details.filter((d) => d.includes('outbox'))).not.toEqual([]);
    });
  });
});
