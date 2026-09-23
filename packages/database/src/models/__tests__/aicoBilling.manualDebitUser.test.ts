import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import {
  platformAdminUsers,
  userWallets,
  walletTransactions,
} from '../../schemas/aicoOrganization';
import { users } from '../../schemas/user';
import type { LobeChatDatabase } from '../../type';
import { AicoBillingModel } from '../aicoBilling';

const serverDB: LobeChatDatabase = await getTestDB();
const billingModel = new AicoBillingModel(serverDB);

const operatorId = 'opusr_manual_debit';
const userId = 'aico-manual-debit-user';

const clean = async () => {
  await serverDB.delete(walletTransactions);
  await serverDB.delete(userWallets);
  await serverDB.delete(platformAdminUsers);
  await serverDB.delete(users);
};

// Shaped like the prod wallet this was built for: $13.90 granted at a mixed
// rate, $2.32 spent, part of it on a retired key.
const seedWallet = (values: Partial<typeof userWallets.$inferInsert> = {}) =>
  serverDB.insert(userWallets).values({
    balanceMicroUsd: 13_900_000,
    balanceToman: 2_604_860,
    rawCapacityMicroUsd: 11_333_333,
    rawUsageBeforeKeyMicroUsd: 1_893_069,
    settledUsageMicroUsd: 2_321_869,
    userId,
    ...values,
  });

const getWallet = async () =>
  (await serverDB.query.userWallets.findFirst({ where: eq(userWallets.userId, userId) }))!;

beforeEach(async () => {
  await clean();
  await serverDB.insert(users).values({ email: 'user@manual-debit.test', id: userId });
  await serverDB.insert(platformAdminUsers).values({
    email: 'operator@manual-debit.test',
    id: operatorId,
    passwordHash: 'unusable:test',
  });
});

afterEach(clean);

describe('AicoBillingModel.manualDebitUser', () => {
  it('takes unspent money back with a traceable negative ledger row', async () => {
    await seedWallet();

    const { transaction, wallet } = await billingModel.manualDebitUser({
      amountMicroUsd: 10_420_000,
      createdByAdminId: operatorId,
      description: 'Reduce admin grant to 1/10',
      idempotencyKey: 'debit-key-0001',
      userId,
    });

    expect(transaction).toMatchObject({
      amountMicroUsd: -10_420_000,
      balanceAfterMicroUsd: 3_480_000,
      balanceBeforeMicroUsd: 13_900_000,
      createdByAdminId: operatorId,
      description: 'Reduce admin grant to 1/10',
      type: 'manual_debit',
      userId,
    });
    expect(transaction.balanceAfterMicroUsd! - transaction.balanceBeforeMicroUsd!).toBe(
      transaction.amountMicroUsd,
    );
    expect(transaction.balanceAfterToman! - transaction.balanceBeforeToman!).toBe(
      transaction.amountToman,
    );

    // Capacity and the toman mirror fall by the same fraction as the balance.
    const rawRemoved = Math.floor((11_333_333 * 10_420_000) / 13_900_000);
    expect(wallet.rawCapacityMicroUsd).toBe(11_333_333 - rawRemoved);
    expect(transaction.metadata).toMatchObject({ rawCapacityRemovedMicroUsd: rawRemoved });
    expect(wallet.balanceToman).toBe(2_604_860 - Math.floor((2_604_860 * 10_420_000) / 13_900_000));

    // What is left to spend is exactly balance − settled.
    expect(wallet.balanceMicroUsd - wallet.settledUsageMicroUsd).toBe(1_158_131);
  });

  it('refuses to take more than is unspent', async () => {
    await seedWallet();

    await expect(
      billingModel.manualDebitUser({
        amountMicroUsd: 11_578_132,
        description: 'too much',
        idempotencyKey: 'debit-key-0002',
        userId,
      }),
    ).rejects.toThrow('DEBIT_EXCEEDS_AVAILABLE');

    expect((await getWallet()).balanceMicroUsd).toBe(13_900_000);
    expect(await serverDB.select().from(walletTransactions)).toHaveLength(0);
  });

  it('refuses when the capacity left would not cover usage on retired keys', async () => {
    await seedWallet({ rawUsageBeforeKeyMicroUsd: 11_000_000, settledUsageMicroUsd: 0 });

    await expect(
      billingModel.manualDebitUser({
        amountMicroUsd: 5_000_000,
        description: 'past retired usage',
        idempotencyKey: 'debit-key-0003',
        userId,
      }),
    ).rejects.toThrow('DEBIT_EXCEEDS_AVAILABLE');
  });

  it('is idempotent on its key', async () => {
    await seedWallet();
    const params = {
      amountMicroUsd: 1_000_000,
      description: 'once',
      idempotencyKey: 'debit-key-0004',
      userId,
    };

    const first = await billingModel.manualDebitUser(params);
    const second = await billingModel.manualDebitUser(params);

    expect(second.transaction.id).toBe(first.transaction.id);
    expect((await getWallet()).balanceMicroUsd).toBe(12_900_000);
    expect(await serverDB.select().from(walletTransactions)).toHaveLength(1);
  });

  it('refuses an inactive wallet and a blank reason', async () => {
    await seedWallet({ isActive: false });

    await expect(
      billingModel.manualDebitUser({
        amountMicroUsd: 1,
        description: 'x',
        idempotencyKey: 'debit-key-0005',
        userId,
      }),
    ).rejects.toThrow('WALLET_INACTIVE');
    await expect(
      billingModel.manualDebitUser({
        amountMicroUsd: 1,
        description: '  ',
        idempotencyKey: 'debit-key-0006',
        userId,
      }),
    ).rejects.toThrow('DESCRIPTION_REQUIRED');
  });
});
