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
    };
    this.keys.set(hash, row);
    return { ...row };
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
  });

  it('bills usage from before a multiplier change at the old rate', async () => {
    const billing = new AicoBillingModel(db);
    const client = new ControllableOpenRouterClient();
    const keys = new AicoOpenRouterKeyService(db, client);

    await billing.manualCreditUser({
      amountMicroUsd: 12_000_000,
      amountToman: 60_000,
      createdByUserId: userId,
      fxRateTomanPerUsd: 50_000,
      userId,
    });
    await keys.ensureUserKey(userId);

    // Stand the wallet up as if it had been metered at 1.0x until now: $5 of raw
    // spend billed as $5. The platform multiplier row itself is global and other
    // suites read it concurrently, so drive the change from the wallet side.
    await db
      .update(userWallets)
      .set({ billedUsageBeforeBaselineMicroUsd: 0, checkpointMultiplierBp: 10_000 })
      .where(eq(userWallets.userId, userId));

    const keyHash = (await billing.getUserWallet(userId))!.openrouterKeyId!;
    const key = client.keys.get(keyHash);
    key.usage = 5;
    key.limitRemaining = key.limit - key.usage;

    // Reading rebases the checkpoint to the platform's 1.2x: the first $5 keeps
    // its $5, and the meter restarts from there.
    await expect(keys.getUserRemaining(userId)).resolves.toMatchObject({
      usageMicroUsd: 5_000_000,
    });
    const rebased = await billing.getUserWallet(userId);
    expect(Number(rebased!.usageBaselineMicroUsd)).toBe(5_000_000);
    expect(Number(rebased!.billedUsageBeforeBaselineMicroUsd)).toBe(5_000_000);
    expect(Number(rebased!.checkpointMultiplierBp)).toBe(12_000);

    // $2 more of raw spend now bills at 1.2x -> $2.40, for $7.40 in total.
    await keys.ensureUserKey(userId);
    key.usage = 7;
    key.limitRemaining = key.limit - key.usage;
    await expect(keys.getUserRemaining(userId)).resolves.toMatchObject({
      usageMicroUsd: 7_400_000,
    });
  });

  it('falls back to deposit when OpenRouter key is missing', async () => {
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

    const remaining = await keys.getUserRemaining(userId);
    expect(remaining.remainingMicroUsd).toBe(10_000_000);
    expect(remaining.usageMicroUsd).toBeNull();
  });

  it('falls back to deposit when OpenRouter getKey fails', async () => {
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
    expect(remaining.usageMicroUsd).toBeNull();
  });
});
