// @vitest-environment node
import type { LobeChatDatabase } from '@lobechat/database';
import { getTestDB } from '@lobechat/database/test-utils';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { users } from '@/database/schemas';
import {
  type AicoReconciliationCheck,
  aicoReconciliationRuns,
  userWallets,
  walletTransactions,
} from '@/database/schemas/aicoOrganization';
import { KeyVaultsGateKeeper } from '@/server/modules/KeyVaultsEncrypt';
import type { ManagedProviderClient } from '@/server/services/managedProvider';

import { runReconciliation } from './reconciliation';

vi.hoisted(() => {
  process.env.KEY_VAULTS_SECRET ||= 'LA7n9k3JdEcbSgml2sxfw+4TV1AzaaFU5+R176aQz4s=';
});

const userId = 'reconciliation-user';

/** A read-only CVC stand-in: a float and one key's remaining headroom. */
const provider = (opts: { floatUsd: number; remainingUsd: number }) =>
  ({
    capabilities: {
      nativePeriodicLimits: false,
      readKeyBySecret: true,
      revoke: true,
      updateLimit: false,
    },
    createKey: vi.fn(),
    getAccountBalanceUsd: vi.fn(async () => opts.floatUsd),
    getKey: vi.fn(async () => ({ limitRemaining: opts.remainingUsd })),
    providerId: 'cheapvibecode',
    resizeKey: vi.fn(),
    updateKey: vi.fn(),
  }) as unknown as ManagedProviderClient;

const deps = (opts: { floatUsd: number; remainingUsd: number }) => ({
  listOpenRouterKeys: async () => null,
  managed: provider(opts),
  sleep: async () => {},
});

const clean = async (db: LobeChatDatabase) => {
  await db.delete(aicoReconciliationRuns);
  await db.delete(walletTransactions);
  await db.delete(userWallets);
  await db.delete(users);
};

// $5 billed on $4 of raw key capacity, nothing spent, one credit on the books.
const seed = async (db: LobeChatDatabase) => {
  const gateKeeper = await KeyVaultsGateKeeper.initWithEnvKey();
  await db.insert(users).values({ email: 'recon@example.com', id: userId });
  await db.insert(userWallets).values({
    balanceMicroUsd: 5_000_000,
    managedKeyLimitMicroUsd: 4_000_000,
    managedKeyProviderId: 'cheapvibecode',
    openrouterKeyCiphertext: await gateKeeper.encrypt('sk-cvc-recon'),
    openrouterKeyId: 'cvc-key-1',
    rawCapacityMicroUsd: 4_000_000,
    userId,
  });
  await db.insert(walletTransactions).values({
    amountMicroUsd: 5_000_000,
    amountToman: 0,
    balanceAfterMicroUsd: 5_000_000,
    balanceBeforeMicroUsd: 0,
    createdByUserId: userId,
    description: 'top-up',
    type: 'topup',
    userId,
  });
};

const checkOf = (run: { checks: AicoReconciliationCheck[] }, id: string) =>
  run.checks.find((c) => c.id === id)!;

describe('runReconciliation', () => {
  let db: LobeChatDatabase;

  beforeEach(async () => {
    db = await getTestDB();
    await clean(db);
    await seed(db);
  });

  afterEach(() => clean(db));

  it('passes when the books, the key and the float agree', async () => {
    const run = await runReconciliation(
      db,
      { trigger: 'cron' },
      deps({ floatUsd: 20, remainingUsd: 4 }),
    );

    expect(run.status).toBe('ok');
    expect(run.finishedAt).not.toBeNull();
    expect(checkOf(run, 'float_liability')).toMatchObject({
      status: 'ok',
      values: { exposureRawMicroUsd: 4_000_000, floatRawMicroUsd: 20_000_000 },
    });
  });

  it('flags a balance its transactions do not explain', async () => {
    await db
      .update(userWallets)
      .set({ balanceMicroUsd: 6_000_000 })
      .where(eq(userWallets.userId, userId));

    const run = await runReconciliation(
      db,
      { trigger: 'cron' },
      deps({ floatUsd: 20, remainingUsd: 4.8 }),
    );

    expect(run.status).toBe('critical');
    expect(checkOf(run, 'wallet_ledger')).toMatchObject({
      status: 'critical',
      values: { unexplainedMicroUsd: 1_000_000 },
    });
  });

  it('flags a broken before/after chain', async () => {
    await db.insert(walletTransactions).values({
      amountMicroUsd: -1_000_000,
      amountToman: 0,
      balanceAfterMicroUsd: 3_000_000,
      balanceBeforeMicroUsd: 4_000_000,
      createdAt: new Date(Date.now() + 1000),
      createdByUserId: userId,
      description: 'bad row',
      type: 'adjustment',
      userId,
    });
    await db
      .update(userWallets)
      .set({ balanceMicroUsd: 4_000_000 })
      .where(eq(userWallets.userId, userId));

    const run = await runReconciliation(
      db,
      { trigger: 'cron' },
      deps({ floatUsd: 20, remainingUsd: 3.2 }),
    );

    const ledger = checkOf(run, 'wallet_ledger');
    expect(ledger.status).toBe('critical');
    expect(ledger.details.join('\n')).toContain('previous row ended at $5.0000');
  });

  it('goes red when live keys can spend more than the float', async () => {
    const run = await runReconciliation(
      db,
      { trigger: 'cron' },
      deps({ floatUsd: 3, remainingUsd: 4 }),
    );

    expect(checkOf(run, 'float_liability')).toMatchObject({ status: 'critical' });
    expect(run.status).toBe('critical');
  });

  it('warns in the danger zone below the float', async () => {
    const run = await runReconciliation(
      db,
      { trigger: 'cron' },
      deps({ floatUsd: 4.5, remainingUsd: 4 }),
    );

    expect(checkOf(run, 'float_liability')).toMatchObject({ status: 'warn' });
  });

  it('flags a key that can spend more than the wallet has left', async () => {
    const run = await runReconciliation(
      db,
      { trigger: 'cron' },
      deps({ floatUsd: 20, remainingUsd: 6 }),
    );

    expect(checkOf(run, 'key_drift')).toMatchObject({ status: 'critical' });
  });

  it('flags a transaction with no actor', async () => {
    await db.insert(walletTransactions).values({
      amountMicroUsd: 0,
      amountToman: 0,
      balanceAfterMicroUsd: 5_000_000,
      balanceBeforeMicroUsd: 5_000_000,
      createdAt: new Date(Date.now() + 1000),
      type: 'adjustment',
      userId,
    });

    const run = await runReconciliation(
      db,
      { trigger: 'cron' },
      deps({ floatUsd: 20, remainingUsd: 4 }),
    );

    expect(checkOf(run, 'ledger_actor')).toMatchObject({ status: 'warn' });
  });

  it('flags enabled OpenRouter keys that nothing points at', async () => {
    const run = await runReconciliation(
      db,
      { trigger: 'cron' },
      {
        ...deps({ floatUsd: 20, remainingUsd: 4 }),
        listOpenRouterKeys: async () => [
          { hash: 'orphan-1', name: 'aico-user-x' },
          { hash: 'hand-made', name: 'Default key' },
        ],
      },
    );

    expect(checkOf(run, 'openrouter_orphans')).toMatchObject({
      status: 'warn',
      values: { enabledKeys: 2, issues: 1 },
    });
  });

  it('returns the latest run instead of re-running a manual trigger within a minute', async () => {
    const first = await runReconciliation(
      db,
      { trigger: 'manual' },
      deps({ floatUsd: 20, remainingUsd: 4 }),
    );
    const second = await runReconciliation(
      db,
      { trigger: 'manual' },
      deps({ floatUsd: 20, remainingUsd: 4 }),
    );

    expect(second.id).toBe(first.id);
    expect(await db.select().from(aicoReconciliationRuns)).toHaveLength(1);
  });
});
