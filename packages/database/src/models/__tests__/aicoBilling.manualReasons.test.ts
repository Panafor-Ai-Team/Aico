import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import { platformAdminUsers, walletTransactions } from '../../schemas/aicoOrganization';
import { users } from '../../schemas/user';
import type { LobeChatDatabase } from '../../type';
import { AicoBillingModel, LEGACY_MANUAL_CREDIT_REASON } from '../aicoBilling';

const serverDB: LobeChatDatabase = await getTestDB();
const billingModel = new AicoBillingModel(serverDB);

const operatorId = 'opusr_manual_reasons';
const userId = 'aico-manual-reasons-user';

const clean = async () => {
  await serverDB.delete(walletTransactions);
  await serverDB.delete(platformAdminUsers);
  await serverDB.delete(users);
};

let minute = 0;
/** One ledger row, each a minute after the last so "most recent" is unambiguous. */
const record = (values: Partial<typeof walletTransactions.$inferInsert>) =>
  serverDB.insert(walletTransactions).values({
    amountMicroUsd: 1_000_000,
    amountToman: 100_000,
    createdAt: new Date(Date.UTC(2026, 8, 24, 0, (minute += 1))),
    createdByAdminId: operatorId,
    type: 'manual_credit',
    userId,
    ...values,
  });

beforeEach(async () => {
  minute = 0;
  await clean();
  await serverDB.insert(users).values({ email: 'user@manual-reasons.test', id: userId });
  await serverDB.insert(platformAdminUsers).values({
    email: 'operator@manual-reasons.test',
    id: operatorId,
    passwordHash: 'unusable:test',
  });
});

afterEach(clean);

describe('AicoBillingModel.listManualReasons', () => {
  it('offers each reason once, most recently used first', async () => {
    await record({ description: 'Support credit' });
    await record({ description: 'Bank transfer' });
    await record({ description: '  Support credit ' });

    expect(await billingModel.listManualReasons('credit')).toEqual([
      'Support credit',
      'Bank transfer',
    ]);
  });

  it('keeps credit and debit reasons apart', async () => {
    await record({ description: 'Bank transfer' });
    await record({ description: 'Grant never paid for', type: 'manual_debit' });

    expect(await billingModel.listManualReasons('credit')).toEqual(['Bank transfer']);
    expect(await billingModel.listManualReasons('debit')).toEqual(['Grant never paid for']);
  });

  it('leaves out blank reasons, the legacy backfill and credits no admin made', async () => {
    await record({ description: null });
    await record({ description: '   ' });
    await record({ description: LEGACY_MANUAL_CREDIT_REASON });
    await record({ createdByAdminId: null, createdByUserId: userId, description: 'Org top-up' });
    await record({ description: 'Refund for outage', type: 'topup' });

    expect(await billingModel.listManualReasons('credit')).toEqual([]);
  });

  it('stops at the limit', async () => {
    for (const n of [1, 2, 3]) await record({ description: `Reason ${n}` });

    expect(await billingModel.listManualReasons('credit', 2)).toEqual(['Reason 3', 'Reason 2']);
  });
});
