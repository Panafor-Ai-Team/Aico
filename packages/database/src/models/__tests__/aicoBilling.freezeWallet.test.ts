import type { SQL } from 'drizzle-orm';
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

/**
 * Runs `competing` inside the model's next transaction, after its reads and
 * just before its first wallet UPDATE — the order a concurrent commit lands in
 * under READ COMMITTED when the read takes no lock. PGlite has one connection,
 * so this is how a race is replayed deterministically.
 */
const interleaveBeforeWalletUpdate = (competing: SQL) => {
  const original = serverDB.transaction.bind(serverDB);
  return vi.spyOn(serverDB, 'transaction').mockImplementationOnce(((cb: any, config: any) =>
    original(async (tx: any) => {
      const update = tx.update.bind(tx);
      let fired = false;
      tx.update = (table: unknown) => {
        const builder = update(table);
        if (table !== userWallets || fired) return builder;
        fired = true;
        const set = builder.set.bind(builder);
        builder.set = (values: unknown) => {
          const query = set(values);
          const execute = query.execute.bind(query);
          query.execute = async (...args: unknown[]) => {
            await tx.execute(competing);
            return execute(...args);
          };
          return query;
        };
        return builder;
      };
      return cb(tx);
    }, config)) as any);
};

beforeEach(async () => {
  await serverDB.delete(walletTransactions);
  await serverDB.delete(userWallets);
  await serverDB.delete(users);
  await serverDB.insert(users).values({ email: 'freeze@wallet.test', id: userId });
});

afterEach(async () => {
  vi.restoreAllMocks();
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

  describe('N1: a concurrent write between the read and the update', () => {
    it('a second unfreeze committing first does not pay the frozen amount twice', async () => {
      await credit(6_000_000, 'n1-double-seed');
      await billingModel.freezePersonalWallet({ userId });
      const frozen = await readWallet();

      // What the other admin click commits while this one is between read and write.
      interleaveBeforeWalletUpdate(sql`
        UPDATE user_wallets SET
          balance_micro_usd = balance_micro_usd + frozen_micro_usd,
          raw_capacity_micro_usd = raw_capacity_micro_usd + frozen_raw_capacity_micro_usd,
          frozen_micro_usd = 0,
          frozen_raw_capacity_micro_usd = 0,
          is_active = true
        WHERE user_id = ${userId}`);
      await billingModel.unfreezePersonalWallet({ userId });

      const wallet = await readWallet();
      expect(Number(wallet.balanceMicroUsd)).toBe(6_000_000);
      expect(Number(wallet.rawCapacityMicroUsd)).toBe(Number(frozen.frozenRawCapacityMicroUsd));
      expect(Number(wallet.frozenMicroUsd)).toBe(0);
    });

    it('a credit committing during a freeze is parked, not lost', async () => {
      await credit(6_000_000, 'n1-credit-seed');
      const before = await readWallet();

      interleaveBeforeWalletUpdate(sql`
        UPDATE user_wallets SET
          balance_micro_usd = balance_micro_usd + 1000000,
          raw_capacity_micro_usd = raw_capacity_micro_usd + 1000000
        WHERE user_id = ${userId}`);
      await billingModel.freezePersonalWallet({ userId });

      const wallet = await readWallet();
      expect(Number(wallet.balanceMicroUsd)).toBe(0);
      expect(Number(wallet.rawCapacityMicroUsd)).toBe(0);
      expect(Number(wallet.frozenMicroUsd)).toBe(7_000_000);
      expect(Number(wallet.frozenRawCapacityMicroUsd)).toBe(
        Number(before.rawCapacityMicroUsd) + 1_000_000,
      );
    });

    it('a debit committing during a freeze is not parked again', async () => {
      await credit(6_000_000, 'n1-debit-seed');

      interleaveBeforeWalletUpdate(sql`
        UPDATE user_wallets SET balance_micro_usd = balance_micro_usd - 2000000
        WHERE user_id = ${userId}`);
      await billingModel.freezePersonalWallet({ userId });

      const wallet = await readWallet();
      expect(Number(wallet.balanceMicroUsd)).toBe(0);
      expect(Number(wallet.frozenMicroUsd)).toBe(4_000_000);
    });
  });
});
