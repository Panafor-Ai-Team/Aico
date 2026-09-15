/**
 * Migration 0153 — the mint-time limit of a managed key, and the raw spend
 * carried across a key rotation.
 *
 * Both exist because CheapVibeCode reports only a key's *remaining* allowance
 * and cannot have a key's limit raised after mint. Spend is therefore
 * `limit - remaining`, the limit is knowable only to us, and funding a member
 * further means minting a replacement key whose counter starts at zero.
 */
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import { memberBudgets, userWallets } from '../../schemas/aicoOrganization';
import type { LobeChatDatabase } from '../../type';
import { AicoBillingModel } from '../aicoBilling';
import { OrganizationModel } from '../organization';
import { cleanupAicoTables, seedUsers } from './aico.phase2.helpers';

const serverDB: LobeChatDatabase = await getTestDB();
const billingModel = new AicoBillingModel(serverDB);
const orgModel = new OrganizationModel(serverDB);

const ownerId = 'mkl-owner';
const memberUserId = 'mkl-member';

const usd = (n: number) => Math.round(n * 1_000_000);

beforeEach(async () => {
  await cleanupAicoTables(serverDB);
  await seedUsers(serverDB, [
    { email: 'mkl-owner@example.com', id: ownerId },
    { email: 'mkl-member@example.com', id: memberUserId },
  ]);
});

afterEach(async () => {
  await cleanupAicoTables(serverDB);
});

const readWallet = async () =>
  serverDB.query.userWallets.findFirst({ where: eq(userWallets.userId, ownerId) });

const setupMember = async () => {
  const org = await orgModel.createOrganization({ name: 'MKL Org', ownerUserId: ownerId });
  await orgModel.addManualCredit({
    amountMicroUsd: usd(100),
    amountToman: 500_000,
    createdByUserId: ownerId,
    fxRateTomanPerUsd: 5000,
    orgId: org.id,
  });
  const invite = await orgModel.createInvite({
    identifierType: 'email',
    identifierValue: 'mkl-member@example.com',
    invitedByUserId: ownerId,
    orgId: org.id,
    role: 'member',
  });
  const { member } = await orgModel.acceptInvite({
    email: 'mkl-member@example.com',
    token: invite.token,
    userId: memberUserId,
  });
  await orgModel.allocateMemberCredit({
    createdByUserId: ownerId,
    orgId: org.id,
    orgMemberId: member.id,
    period: 'daily',
    periodAmountMicroUsd: usd(10),
  });
  return { member, org };
};

describe('user_wallets.managed_key_limit_micro_usd', () => {
  it('persists the limit alongside the key', async () => {
    await billingModel.getOrCreateUserWallet(ownerId);

    await billingModel.updateUserOpenRouterKey({
      ciphertext: 'cipher-1',
      keyId: 'key-1',
      managedKeyLimitMicroUsd: 800_000,
      userId: ownerId,
    });

    expect((await readWallet())?.managedKeyLimitMicroUsd).toBe(800_000);
  });

  it('defaults to null — unknown, not a fully spent key', async () => {
    await billingModel.getOrCreateUserWallet(ownerId);

    expect((await readWallet())?.managedKeyLimitMicroUsd).toBeNull();
  });

  it('leaves an existing limit untouched when the caller omits it', async () => {
    await billingModel.getOrCreateUserWallet(ownerId);
    await billingModel.updateUserOpenRouterKey({
      ciphertext: 'cipher-1',
      keyId: 'key-1',
      managedKeyLimitMicroUsd: 800_000,
      userId: ownerId,
    });

    // The OpenRouter path never passes a limit; it must not wipe one.
    await billingModel.updateUserOpenRouterKey({
      ciphertext: 'cipher-2',
      keyId: 'key-2',
      userId: ownerId,
    });

    expect((await readWallet())?.managedKeyLimitMicroUsd).toBe(800_000);
  });

  it('clears the limit when explicitly passed null', async () => {
    await billingModel.getOrCreateUserWallet(ownerId);
    await billingModel.updateUserOpenRouterKey({
      ciphertext: 'cipher-1',
      keyId: 'key-1',
      managedKeyLimitMicroUsd: 800_000,
      userId: ownerId,
    });

    await billingModel.updateUserOpenRouterKey({
      ciphertext: 'cipher-2',
      keyId: 'key-2',
      managedKeyLimitMicroUsd: null,
      userId: ownerId,
    });

    expect((await readWallet())?.managedKeyLimitMicroUsd).toBeNull();
  });
});

describe('user_wallets.raw_usage_before_key_micro_usd', () => {
  it('starts at zero — a wallet that never rotated has spent nothing on an old key', async () => {
    await billingModel.getOrCreateUserWallet(ownerId);

    expect((await readWallet())?.rawUsageBeforeKeyMicroUsd).toBe(0);
  });
});

describe('member_budgets.managed_key_limit_micro_usd', () => {
  it('persists the limit alongside the key', async () => {
    const { member } = await setupMember();

    await orgModel.updateMemberOpenRouterKey({
      ciphertext: 'cipher-1',
      keyId: 'key-1',
      managedKeyLimitMicroUsd: 8_000_000,
      orgMemberId: member.id,
    });

    const row = await serverDB.query.memberBudgets.findFirst({
      where: eq(memberBudgets.orgMemberId, member.id),
    });
    expect(row?.managedKeyLimitMicroUsd).toBe(8_000_000);
  });

  it('leaves an existing limit untouched when the caller omits it', async () => {
    const { member } = await setupMember();
    await orgModel.updateMemberOpenRouterKey({
      ciphertext: 'cipher-1',
      keyId: 'key-1',
      managedKeyLimitMicroUsd: 8_000_000,
      orgMemberId: member.id,
    });

    await orgModel.updateMemberOpenRouterKey({
      ciphertext: 'cipher-2',
      keyId: 'key-2',
      orgMemberId: member.id,
    });

    const row = await serverDB.query.memberBudgets.findFirst({
      where: eq(memberBudgets.orgMemberId, member.id),
    });
    expect(row?.managedKeyLimitMicroUsd).toBe(8_000_000);
  });

  it('defaults to null for a freshly allocated budget', async () => {
    const { member } = await setupMember();

    const row = await serverDB.query.memberBudgets.findFirst({
      where: eq(memberBudgets.orgMemberId, member.id),
    });
    expect(row?.managedKeyLimitMicroUsd).toBeNull();
  });
});
