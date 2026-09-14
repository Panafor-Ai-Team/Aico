/**
 * getUserRemaining — personal spendable balance from OpenRouter limit_remaining
 */
// @vitest-environment node
import type { LobeChatDatabase } from '@lobechat/database';
import { getTestDB } from '@lobechat/database/test-utils';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AicoBillingModel } from '@/database/models/aicoBilling';
import { users } from '@/database/schemas';
import { userWallets, walletTransactions } from '@/database/schemas/aicoOrganization';
import { AicoOpenRouterKeyService } from '@/server/services/openrouter/keyService';
import type { OpenRouterManagementClient } from '@/server/services/openrouter/management';

class ControllableOpenRouterClient implements OpenRouterManagementClient {
  keys = new Map<string, any>();

  createKey: OpenRouterManagementClient['createKey'] = async (params) => {
    const hash = `ctrl_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
    const row = {
      disabled: false,
      hash,
      key: `sk-or-v1-mock-${hash}`,
      limit: params.limitUsd,
      limitRemaining: params.limitUsd,
      name: params.name,
      usage: 0,
      usageDaily: 0,
      usageMonthly: 0,
      usageWeekly: 0,
    };
    this.keys.set(hash, row);
    return { ...row };
  };

  deleteKey: OpenRouterManagementClient['deleteKey'] = async (hash) => {
    this.keys.delete(hash);
  };

  getKey: OpenRouterManagementClient['getKey'] = async (hash) => {
    const row = this.keys.get(hash);
    if (!row) throw new Error(`OpenRouter mock key not found: ${hash}`);
    const { key: _k, ...info } = row;
    return info;
  };

  updateKey: OpenRouterManagementClient['updateKey'] = async (params) => {
    const row = this.keys.get(params.hash);
    if (!row) throw new Error(`OpenRouter mock key not found: ${params.hash}`);
    if (params.disabled !== undefined) row.disabled = params.disabled;
    if (params.limitUsd !== undefined) {
      row.limit = params.limitUsd;
      row.limitRemaining = Math.max(0, params.limitUsd - row.usage);
    }
    const { key: _k, ...info } = row;
    return info;
  };
}

describe('getUserRemaining', () => {
  let db: LobeChatDatabase;
  const userId = 'user_remaining_test';

  beforeEach(async () => {
    db = await getTestDB();
    await db.delete(walletTransactions);
    await db.delete(userWallets);
    await db.delete(users);
    await db.insert(users).values({ id: userId, username: 'remaining-user' });
  });

  afterEach(async () => {
    await db.delete(walletTransactions);
    await db.delete(userWallets);
    await db.delete(users);
  });

  it('prefers OpenRouter limit_remaining over deposited balance', async () => {
    const billing = new AicoBillingModel(db);
    const client = new ControllableOpenRouterClient();
    const keys = new AicoOpenRouterKeyService(db, client);

    await billing.manualCreditUser({
      amountMicroUsd: 10_000_000,
      amountToman: 50_000,
      createdByUserId: userId,
      fxRateTomanPerUsd: 50_000,
      userId,
    });
    await keys.ensureUserKey(userId);

    const wallet = await billing.getUserWallet(userId);
    const keyHash = wallet!.openrouterKeyId!;
    const key = client.keys.get(keyHash);

    // AICO-180: a $10 wallet buys $10 / 1.2 = $8.333333 of raw upstream spend.
    expect(key.limit).toBeCloseTo(8.333_333, 6);

    // $2.50 of raw usage bills as $3.00, leaving $7.00 of the $10 wallet.
    key.usage = 2.5;
    key.limitRemaining = key.limit - key.usage;

    const remaining = await keys.getUserRemaining(userId);
    expect(remaining.remainingMicroUsd).toBe(7_000_000);
    expect(remaining.usageMicroUsd).toBe(3_000_000);
    expect(remaining.usageKnown).toBe(true);
  });

  it('credits capacity at the multiplier in force when the top-up was paid', async () => {
    const billing = new AicoBillingModel(db);
    const client = new ControllableOpenRouterClient();
    const keys = new AicoOpenRouterKeyService(db, client);

    const { transaction } = await billing.manualCreditUser({
      amountMicroUsd: 12_000_000,
      amountToman: 60_000,
      createdByUserId: userId,
      fxRateTomanPerUsd: 50_000,
      userId,
    });

    // AICO-184: $12 at 1.2x buys $10 of raw spend, once and for good.
    const wallet = await billing.getUserWallet(userId);
    expect(Number(wallet!.rawCapacityMicroUsd)).toBe(10_000_000);
    // The rate is stamped on the transaction so it can never be re-derived.
    expect(transaction.metadata).toMatchObject({
      multiplierBp: 12_000,
      rawCapacityAddedMicroUsd: 10_000_000,
    });

    await keys.ensureUserKey(userId);
    const keyed = await billing.getUserWallet(userId);
    expect(client.keys.get(keyed!.openrouterKeyId!).limit).toBeCloseTo(10, 6);
  });

  it('does not revalue a paid-for balance when the multiplier changes (AICO-184)', async () => {
    const billing = new AicoBillingModel(db);
    const client = new ControllableOpenRouterClient();
    const keys = new AicoOpenRouterKeyService(db, client);

    await billing.manualCreditUser({
      amountMicroUsd: 1_200_000,
      amountToman: 6000,
      createdByUserId: userId,
      fxRateTomanPerUsd: 50_000,
      userId,
    });

    // Stand in for a second top-up of $1.50 made after the platform rate moved
    // to 1.5x: $1.50 / 1.5 = $1.00 more of raw spend. Written directly because
    // the multiplier config row is global and other suites read it concurrently.
    await db
      .update(userWallets)
      .set({ balanceMicroUsd: 2_700_000, rawCapacityMicroUsd: 2_000_000 })
      .where(eq(userWallets.userId, userId));

    await keys.ensureUserKey(userId);
    const wallet = await billing.getUserWallet(userId);
    const key = client.keys.get(wallet!.openrouterKeyId!);

    // $2.00 of capacity — what the two purchases were worth at their own rates.
    // Dividing the $2.70 balance by the current 1.5x would have given $1.80.
    expect(key.limit).toBeCloseTo(2, 6);

    // $1 of raw spend bills at the 1.35 blend the wallet actually bought at.
    key.usage = 1;
    key.limitRemaining = key.limit - key.usage;
    await expect(keys.getUserRemaining(userId)).resolves.toEqual({
      remainingMicroUsd: 1_350_000,
      usageKnown: true,
      usageMicroUsd: 1_350_000,
    });

    // Spending the whole capacity bills the whole balance, to the micro-USD.
    key.usage = 2;
    key.limitRemaining = 0;
    await expect(keys.getUserRemaining(userId)).resolves.toEqual({
      remainingMicroUsd: 0,
      usageKnown: true,
      usageMicroUsd: 2_700_000,
    });
  });

  it('reports a wallet with no managed key as fully spendable and known-unspent', async () => {
    const billing = new AicoBillingModel(db);
    const client = new ControllableOpenRouterClient();
    const keys = new AicoOpenRouterKeyService(db, client);

    await billing.manualCreditUser({
      amountMicroUsd: 10_000_000,
      amountToman: 50_000,
      createdByUserId: userId,
      fxRateTomanPerUsd: 50_000,
      userId,
    });

    // No key was ever provisioned, so no spend was possible through us. That is
    // a known zero — the one case where the full balance really is spendable.
    const remaining = await keys.getUserRemaining(userId);
    expect(remaining.remainingMicroUsd).toBe(10_000_000);
    expect(remaining.usageMicroUsd).toBe(0);
    expect(remaining.usageKnown).toBe(true);
  });

  it('FIN-018 a failed key read is reported as unknown, not as an unspent wallet', async () => {
    const billing = new AicoBillingModel(db);
    const client = new ControllableOpenRouterClient();
    const keys = new AicoOpenRouterKeyService(db, client);

    await billing.manualCreditUser({
      amountMicroUsd: 3_000_000,
      amountToman: 15_000,
      createdByUserId: userId,
      fxRateTomanPerUsd: 50_000,
      userId,
    });
    await billing.updateUserOpenRouterKey({
      ciphertext: 'cipher',
      keyId: 'missing-key-hash',
      userId,
    });

    const remaining = await keys.getUserRemaining(userId);
    expect(remaining.remainingMicroUsd).toBe(3_000_000);
    expect(remaining.usageKnown).toBe(false);
  });

  it('FIN-018 a degraded read holds the last settled usage instead of forgetting it', async () => {
    const billing = new AicoBillingModel(db);
    const client = new ControllableOpenRouterClient();
    const keys = new AicoOpenRouterKeyService(db, client);

    await billing.manualCreditUser({
      amountMicroUsd: 10_000_000,
      amountToman: 50_000,
      createdByUserId: userId,
      fxRateTomanPerUsd: 50_000,
      userId,
    });
    await keys.ensureUserKey(userId);

    const wallet = await billing.getUserWallet(userId);
    const key = client.keys.get(wallet!.openrouterKeyId!);

    // A good read persists the derived figure...
    key.usage = 2.5;
    key.limitRemaining = key.limit - key.usage;
    await keys.getUserRemaining(userId, { persist: true });
    const synced = await billing.getUserWallet(userId);
    expect(Number(synced!.settledUsageMicroUsd)).toBe(3_000_000);
    expect(synced!.lastSyncStatus).toBe('synced');

    // ...so when OpenRouter goes away, remaining does not spring back to the
    // full $10 and tell the user they have spent nothing.
    client.keys.delete(wallet!.openrouterKeyId!);
    const degraded = await keys.getUserRemaining(userId, { persist: true });
    expect(degraded.remainingMicroUsd).toBe(7_000_000);
    expect(degraded.usageMicroUsd).toBe(3_000_000);
    expect(degraded.usageKnown).toBe(false);

    const after = await billing.getUserWallet(userId);
    expect(after!.lastSyncStatus).toBe('degraded');
    expect(after!.lastSyncError).toBeTruthy();
    // The held figure must not be overwritten by the failed read.
    expect(Number(after!.settledUsageMicroUsd)).toBe(3_000_000);
  });

  it('FIN-018 a placeholder key id is unknown usage, not zero usage', async () => {
    const billing = new AicoBillingModel(db);
    const client = new ControllableOpenRouterClient();
    const keys = new AicoOpenRouterKeyService(db, client);

    await billing.manualCreditUser({
      amountMicroUsd: 10_000_000,
      amountToman: 50_000,
      createdByUserId: userId,
      fxRateTomanPerUsd: 50_000,
      userId,
    });
    await billing.updateUserOpenRouterKey({ ciphertext: 'cipher', keyId: 'mock_abc', userId });
    await db
      .update(userWallets)
      .set({ settledUsageMicroUsd: 4_000_000 })
      .where(eq(userWallets.userId, userId));

    const remaining = await keys.getUserRemaining(userId);
    expect(remaining.usageKnown).toBe(false);
    expect(remaining.remainingMicroUsd).toBe(6_000_000);
  });

  it('does not write on the chat hot path unless persistence is asked for', async () => {
    const billing = new AicoBillingModel(db);
    const client = new ControllableOpenRouterClient();
    const keys = new AicoOpenRouterKeyService(db, client);

    await billing.manualCreditUser({
      amountMicroUsd: 10_000_000,
      amountToman: 50_000,
      createdByUserId: userId,
      fxRateTomanPerUsd: 50_000,
      userId,
    });
    await keys.ensureUserKey(userId);

    await keys.getUserRemaining(userId);
    const wallet = await billing.getUserWallet(userId);
    expect(wallet!.lastSyncStatus).toBe('never');
    expect(wallet!.lastSyncedAt).toBeNull();
  });
});
