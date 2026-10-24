/**
 * C1 — what the account tomb records when a user with a personal balance is deleted.
 */
// @vitest-environment node
import type { LobeChatDatabase } from '@lobechat/database';
import { getTestDB } from '@lobechat/database/test-utils';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AicoBillingModel } from '@/database/models/aicoBilling';
import { users } from '@/database/schemas';
import {
  aicoAccountTombs,
  aicoKeyOutbox,
  userWallets,
  walletTransactions,
} from '@/database/schemas/aicoOrganization';

import { AicoSoftDeleteService } from './softDelete';

const userId = 'soft-delete-user';

describe('AicoSoftDeleteService wallet freeze', () => {
  let db: LobeChatDatabase;
  let billing: AicoBillingModel;

  const clean = async () => {
    await db.delete(aicoKeyOutbox);
    await db.delete(aicoAccountTombs);
    await db.delete(walletTransactions);
    await db.delete(userWallets);
    await db.delete(users);
  };

  beforeEach(async () => {
    db = await getTestDB();
    billing = new AicoBillingModel(db);
    await clean();
    await db.insert(users).values({ email: 'soft-delete@example.com', id: userId });
    await billing.manualCreditUser({
      amountMicroUsd: 6_000_000,
      amountToman: 300_000,
      createdByUserId: userId,
      fxRateTomanPerUsd: 50_000,
      idempotencyKey: 'soft-delete-seed',
      userId,
    });
  });

  afterEach(clean);

  const tomb = () =>
    db.query.aicoAccountTombs.findFirst({ where: eq(aicoAccountTombs.userId, userId) });

  it('records the parked balance on the tomb', async () => {
    await new AicoSoftDeleteService(db).softDeleteUser({ userId });

    expect(Number((await tomb())?.frozenPersonalMicroUsd)).toBe(6_000_000);
  });

  it('still records it when an earlier half-finished run already froze the wallet', async () => {
    // A first run that froze the wallet and then failed before the tomb was
    // written: the retry reads a zero balance, and used to write a zero tomb.
    await billing.freezePersonalWallet({ userId });

    await new AicoSoftDeleteService(db).softDeleteUser({ userId });

    expect(Number((await tomb())?.frozenPersonalMicroUsd)).toBe(6_000_000);
  });

  it('keeps the unspent figure on the freeze row for whoever decides refunds', async () => {
    await db
      .update(userWallets)
      .set({ settledUsageMicroUsd: 2_500_000 })
      .where(eq(userWallets.userId, userId));

    await new AicoSoftDeleteService(db).softDeleteUser({ userId });

    const row = await db.query.walletTransactions.findFirst({
      where: eq(walletTransactions.type, 'personal_freeze'),
    });
    expect(row?.metadata).toMatchObject({ unspentMicroUsd: 3_500_000 });
  });
});
