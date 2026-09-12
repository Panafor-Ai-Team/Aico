import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import { userWallets, walletTransactions } from '../../schemas/aicoOrganization';
import { users } from '../../schemas/user';
import type { LobeChatDatabase } from '../../type';
import { AicoBillingModel } from '../aicoBilling';

const serverDB: LobeChatDatabase = await getTestDB();
const billingModel = new AicoBillingModel(serverDB);

const userId = 'aico-freeze-user';

const readWallet = async () => {
  const [row] = await serverDB.select().from(userWallets).where(eq(userWallets.userId, userId));
  return row;
};

const credit = (amountMicroUsd: number, idempotencyKey: string) =>
  billingModel.manualCreditUser({
    amountMicroUsd,
    amountToman: amountMicroUsd / 100,
    createdByUserId: userId,
    fxRateTomanPerUsd: 5000,
    idempotencyKey,
    userId,
  });

beforeEach(async () => {
  await serverDB.delete(walletTransactions);
  await serverDB.delete(userWallets);
  await serverDB.delete(users);
  await serverDB.insert(users).values({ email: 'freeze@wallet.test', id: userId });
});

afterEach(async () => {
  await serverDB.delete(walletTransactions);
  await serverDB.delete(userWallets);
  await serverDB.delete(users);
});

describe('FIN-015 personal wallet freeze / unfreeze', () => {
  it('parks balance and the capacity it bought, and records the move on the ledger', async () => {
    await credit(6_000_000, 'freeze-seed');
    const funded = await readWallet();
    expect(Number(funded.balanceMicroUsd)).toBe(6_000_000);
    const purchasedCapacity = Number(funded.rawCapacityMicroUsd);
    expect(purchasedCapacity).toBeGreaterThan(0);

    await billingModel.freezePersonalWallet({ userId });

    const frozen = await readWallet();
    expect(Number(frozen.balanceMicroUsd)).toBe(0);
    expect(Number(frozen.frozenMicroUsd)).toBe(6_000_000);
    expect(frozen.isActive).toBe(false);
    // Capacity is the OpenRouter key limit. Leaving it behind is what let the
    // next credit hand back spend the user never paid for.
    expect(Number(frozen.rawCapacityMicroUsd)).toBe(0);
    expect(Number(frozen.frozenRawCapacityMicroUsd)).toBe(purchasedCapacity);

    const [row] = await serverDB
      .select()
      .from(walletTransactions)
      .where(eq(walletTransactions.type, 'personal_freeze'));
    expect(row).toBeTruthy();
    expect(Number(row.amountMicroUsd)).toBe(-6_000_000);
    expect(Number(row.balanceBeforeMicroUsd)).toBe(6_000_000);
    expect(Number(row.balanceAfterMicroUsd)).toBe(0);
    // INV-6: a wallet must be reconstructable from its ledger.
    expect(Number(row.balanceAfterMicroUsd) - Number(row.balanceBeforeMicroUsd)).toBe(
      Number(row.amountMicroUsd),
    );
  });

  it('restores balance, capacity and spendability on unfreeze', async () => {
    await credit(6_000_000, 'unfreeze-seed');
    const purchasedCapacity = Number((await readWallet()).rawCapacityMicroUsd);

    await billingModel.freezePersonalWallet({ userId });
    await billingModel.unfreezePersonalWallet({ userId });

    const restored = await readWallet();
    expect(Number(restored.balanceMicroUsd)).toBe(6_000_000);
    expect(Number(restored.frozenMicroUsd)).toBe(0);
    expect(Number(restored.rawCapacityMicroUsd)).toBe(purchasedCapacity);
    expect(Number(restored.frozenRawCapacityMicroUsd)).toBe(0);
    expect(restored.isActive).toBe(true);

    const [row] = await serverDB
      .select()
      .from(walletTransactions)
      .where(eq(walletTransactions.type, 'personal_unfreeze'));
    expect(Number(row.amountMicroUsd)).toBe(6_000_000);
    expect(Number(row.balanceAfterMicroUsd) - Number(row.balanceBeforeMicroUsd)).toBe(
      Number(row.amountMicroUsd),
    );
  });

  it('refuses to credit a frozen wallet instead of silently resurrecting it', async () => {
    await credit(6_000_000, 'refuse-seed');
    await billingModel.freezePersonalWallet({ userId });

    await expect(credit(1_000_000, 'refuse-second')).rejects.toThrow('WALLET_INACTIVE');

    const wallet = await readWallet();
    expect(wallet.isActive).toBe(false);
    expect(Number(wallet.balanceMicroUsd)).toBe(0);
    expect(Number(wallet.rawCapacityMicroUsd)).toBe(0);
  });

  it('grants only newly purchased capacity after a freeze and unfreeze cycle', async () => {
    // The P0: capacity surviving a freeze meant the key limit became
    // pre-freeze + newly purchased, i.e. free upstream spend.
    await credit(6_000_000, 'capacity-first');
    const firstCapacity = Number((await readWallet()).rawCapacityMicroUsd);

    await billingModel.freezePersonalWallet({ userId });
    await billingModel.unfreezePersonalWallet({ userId });
    await credit(6_000_000, 'capacity-second');

    const wallet = await readWallet();
    expect(Number(wallet.balanceMicroUsd)).toBe(12_000_000);
    // Exactly two purchases' worth — never three.
    expect(Number(wallet.rawCapacityMicroUsd)).toBe(firstCapacity * 2);
  });

  it('freezing a wallet with no balance moves nothing and writes no ledger row', async () => {
    await billingModel.getOrCreateUserWallet(userId);

    const result = await billingModel.freezePersonalWallet({ userId });

    expect(result?.transaction).toBeNull();
    const rows = await serverDB.select().from(walletTransactions);
    expect(rows).toHaveLength(0);
    expect((await readWallet()).isActive).toBe(false);
  });
});
