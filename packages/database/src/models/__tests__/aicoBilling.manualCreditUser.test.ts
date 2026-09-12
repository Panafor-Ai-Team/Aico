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

const adminId = 'aico-manual-credit-admin';
const operatorId = 'opusr_manual_credit';
const userId = 'aico-manual-credit-user';

beforeEach(async () => {
  await serverDB.delete(walletTransactions);
  await serverDB.delete(userWallets);
  await serverDB.delete(platformAdminUsers);
  await serverDB.delete(users);
  await serverDB.insert(users).values([
    { email: 'admin@manual-credit.test', id: adminId },
    { email: 'user@manual-credit.test', id: userId },
  ]);
  await serverDB.insert(platformAdminUsers).values({
    email: 'operator@manual-credit.test',
    id: operatorId,
    passwordHash: 'unusable:test',
  });
});

afterEach(async () => {
  await serverDB.delete(walletTransactions);
  await serverDB.delete(userWallets);
  await serverDB.delete(platformAdminUsers);
  await serverDB.delete(users);
});

describe('AicoBillingModel.manualCreditUser', () => {
  it('credits a B2C wallet with type manual_credit', async () => {
    const { wallet, transaction } = await billingModel.manualCreditUser({
      amountMicroUsd: 5_000_000,
      amountToman: 25_000,
      createdByUserId: adminId,
      description: 'Platform adjustment',
      fxRateTomanPerUsd: 5000,
      userId,
    });

    expect(transaction.type).toBe('manual_credit');
    expect(transaction.description).toBe('Platform adjustment');
    expect(transaction.createdByUserId).toBe(adminId);
    expect(transaction.createdByAdminId).toBeNull();
    expect(transaction.userId).toBe(userId);
    expect(transaction.balanceBeforeMicroUsd).toBe(0);
    expect(transaction.balanceAfterMicroUsd).toBe(5_000_000);
    expect(transaction.balanceBeforeToman).toBe(0);
    expect(transaction.balanceAfterToman).toBe(25_000);
    expect(wallet.balanceToman).toBe(25_000);
    expect(wallet.balanceMicroUsd).toBe(5_000_000);
    expect(wallet.isActive).toBe(true);
  });

  it('rejects non-positive amounts', async () => {
    await expect(
      billingModel.manualCreditUser({
        amountMicroUsd: 1,
        amountToman: 0,
        createdByUserId: adminId,
        fxRateTomanPerUsd: 5000,
        userId,
      }),
    ).rejects.toThrow('AMOUNT_TOMAN_MUST_BE_POSITIVE_INTEGER');
  });

  it('stamps createdByAdminId and exposes actor email on the admin ledger', async () => {
    const { transaction } = await billingModel.manualCreditUser({
      amountMicroUsd: 1_000_000,
      amountToman: 5000,
      createdByAdminId: operatorId,
      description: 'Ops credit',
      fxRateTomanPerUsd: 5000,
      userId,
    });
    expect(transaction.createdByAdminId).toBe(operatorId);
    expect(transaction.createdByUserId).toBeNull();

    const rows = await billingModel.listRecentTransactions(10);
    expect(rows[0]?.actorAdminEmail).toBe('operator@manual-credit.test');
    expect(rows[0]?.userEmail).toBe('user@manual-credit.test');
    expect(rows[0]?.description).toBe('Ops credit');
  });

  describe('FIN-013 idempotency', () => {
    const credit = (idempotencyKey: string) =>
      billingModel.manualCreditUser({
        amountMicroUsd: 2_000_000,
        amountToman: 10_000,
        createdByAdminId: operatorId,
        fxRateTomanPerUsd: 5000,
        idempotencyKey,
        userId,
      });

    it('credits balance and capacity exactly once when the same key is retried', async () => {
      const first = await credit('fin013-sequential-retry');
      const second = await credit('fin013-sequential-retry');

      expect(second.transaction.id).toBe(first.transaction.id);

      const [wallet] = await serverDB
        .select()
        .from(userWallets)
        .where(eq(userWallets.userId, userId));
      expect(Number(wallet.balanceMicroUsd)).toBe(2_000_000);
      expect(Number(wallet.balanceToman)).toBe(10_000);
      // The OpenRouter key limit is pushed from capacity, so a double-credit
      // here would hand out spend the user never paid for.
      expect(Number(wallet.rawCapacityMicroUsd)).toBeGreaterThan(0);
      const capacityAfterRetry = Number(wallet.rawCapacityMicroUsd);

      const rows = await serverDB
        .select()
        .from(walletTransactions)
        .where(eq(walletTransactions.gatewayRefId, 'fin013-sequential-retry'));
      expect(rows).toHaveLength(1);

      const third = await credit('fin013-sequential-retry');
      expect(third.transaction.id).toBe(first.transaction.id);
      const [afterThird] = await serverDB
        .select()
        .from(userWallets)
        .where(eq(userWallets.userId, userId));
      expect(Number(afterThird.rawCapacityMicroUsd)).toBe(capacityAfterRetry);
    });

    it('resolves concurrent submits of one key to a single credit', async () => {
      // Both callers clear the pre-check before either commits, so the unique
      // index is what separates them. The loser must return the winner's
      // transaction rather than an error the admin would retry.
      const [a, b] = await Promise.all([credit('fin013-concurrent'), credit('fin013-concurrent')]);

      expect(a.transaction.id).toBe(b.transaction.id);

      const [wallet] = await serverDB
        .select()
        .from(userWallets)
        .where(eq(userWallets.userId, userId));
      expect(Number(wallet.balanceMicroUsd)).toBe(2_000_000);

      const rows = await serverDB
        .select()
        .from(walletTransactions)
        .where(eq(walletTransactions.gatewayRefId, 'fin013-concurrent'));
      expect(rows).toHaveLength(1);
    });

    it('rejects a key already used for a different user', async () => {
      await credit('fin013-cross-user');
      await serverDB.insert(users).values({ email: 'other@manual-credit.test', id: 'other-user' });

      await expect(
        billingModel.manualCreditUser({
          amountMicroUsd: 2_000_000,
          amountToman: 10_000,
          createdByAdminId: operatorId,
          fxRateTomanPerUsd: 5000,
          idempotencyKey: 'fin013-cross-user',
          userId: 'other-user',
        }),
      ).rejects.toThrow('IDEMPOTENCY_KEY_CONFLICT');
    });
  });
});
