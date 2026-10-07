// @vitest-environment node
import type { LobeChatDatabase } from '@lobechat/database';
import { getTestDB } from '@lobechat/database/test-utils';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { cleanupAicoTables, seedUsers } from '@/database/models/__tests__/aico.phase2.helpers';
import { OrganizationModel } from '@/database/models/organization';
import { memberBudgets, userWallets } from '@/database/schemas/aicoOrganization';
import { ManagedKeyCapacityError } from '@/server/services/managedProvider/cheapvibecode';

import { aicoBillingRouter } from '../aicoBilling';
import { createTestContext } from './integration/setup';

let testDB: LobeChatDatabase;
vi.mock('@/database/core/db-adaptor', () => ({
  getServerDB: vi.fn(() => testDB),
}));

const h = vi.hoisted(() => ({
  ensureMemberKey: vi.fn(),
  getUserRemaining: vi.fn(),
  shared: false,
  syncMemberCycleUsage: vi.fn(),
}));

vi.mock('@/server/services/aico/ledger/config', () => ({
  isSharedInferenceKey: () => h.shared,
}));

vi.mock('@/server/services/openrouter/keyService', () => ({
  AicoOpenRouterKeyService: class {
    ensureMemberKey = h.ensureMemberKey;
    getUserRemaining = h.getUserRemaining;
    syncMemberCycleUsage = h.syncMemberCycleUsage;
  },
}));

const userId = 'ledger-router-user';
const usd = (n: number) => Math.round(n * 1_000_000);

beforeEach(async () => {
  h.shared = false;
  h.ensureMemberKey.mockReset().mockResolvedValue({ created: false, keyId: null });
  h.getUserRemaining
    .mockReset()
    .mockResolvedValue({ remainingMicroUsd: 0, usageKnown: true, usageMicroUsd: 0 });
  h.syncMemberCycleUsage.mockReset().mockResolvedValue(null);
  testDB = await getTestDB();
  await cleanupAicoTables(testDB);
  await seedUsers(testDB, [{ email: 'ledger-router@example.com', id: userId }]);
});

/** A keyless $5 budget with $1 settled and $1.5 held on an org the user owns. */
const seedKeylessBudget = async () => {
  const orgModel = new OrganizationModel(testDB);
  const org = await orgModel.createOrganization({ name: 'Ledger Router', ownerUserId: userId });
  const me = (await orgModel.listMembers(org.id)).find((m) => m.userId === userId)!;
  await testDB.insert(memberBudgets).values({
    heldMicroUsd: usd(1.5),
    orgId: org.id,
    orgMemberId: me.id,
    periodAmountMicroUsd: usd(5),
    settledUsageMicroUsd: usd(1),
  });
  return org;
};

describe('aicoBilling router under the shared inference key', () => {
  it('reports a keyless wallet as usable', async () => {
    h.shared = true;
    const caller = aicoBillingRouter.createCaller(createTestContext(userId));

    const wallet = await caller.getMyWallet();
    expect(wallet.hasManagedKey).toBe(true);

    const sources = await caller.getMyBillingSources();
    expect(sources.sources.find((s) => s.source === 'personal')?.hasManagedKey).toBe(true);
  });

  it('keeps requiring a key without the shared key', async () => {
    const caller = aicoBillingRouter.createCaller(createTestContext(userId));
    expect((await caller.getMyWallet()).hasManagedKey).toBe(false);
  });

  it('subtracts held spend from org remaining and never repairs a member key', async () => {
    h.shared = true;
    const org = await seedKeylessBudget();
    const caller = aicoBillingRouter.createCaller(createTestContext(userId));

    const sources = await caller.getMyBillingSources();
    const source = sources.sources.find(
      (s) => s.source === 'organization' && s.organizationId === org.id,
    )!;

    expect(source.hasManagedKey).toBe(true);
    expect(source.remainingMicroUsd).toBe(String(usd(2.5)));
    expect(h.ensureMemberKey).not.toHaveBeenCalled();
    expect(h.syncMemberCycleUsage).not.toHaveBeenCalled();
  });

  it('skips live remaining sync when syncLive is false', async () => {
    h.shared = false;
    const orgModel = new OrganizationModel(testDB);
    const org = await orgModel.createOrganization({ name: 'No Sync Org', ownerUserId: userId });
    const me = (await orgModel.listMembers(org.id)).find((m) => m.userId === userId)!;
    await testDB.insert(memberBudgets).values({
      openrouterKeyId: 'or-key-member',
      orgId: org.id,
      orgMemberId: me.id,
      periodAmountMicroUsd: usd(5),
      settledUsageMicroUsd: usd(1),
    });
    await testDB.insert(userWallets).values({
      balanceMicroUsd: usd(3),
      openrouterKeyId: 'or-key-user',
      settledUsageMicroUsd: usd(1),
      userId,
    });

    const caller = aicoBillingRouter.createCaller(createTestContext(userId));
    const sources = await caller.getMyBillingSources({ syncLive: false });

    expect(h.getUserRemaining).toHaveBeenCalledWith(userId, { live: false, persist: false });
    expect(h.syncMemberCycleUsage).not.toHaveBeenCalled();
    expect(h.ensureMemberKey).not.toHaveBeenCalled();
    expect(sources.sources.find((s) => s.source === 'personal')?.usageKnown).toBeDefined();
  });

  it('derives personal credit from ledger remaining for a keyless wallet', async () => {
    h.shared = true;
    await testDB.insert(userWallets).values({ balanceMicroUsd: usd(2), userId });
    const caller = aicoBillingRouter.createCaller(createTestContext(userId));

    await expect(caller.getManagedProviderStatus()).resolves.toMatchObject({ hasCredit: false });

    h.getUserRemaining.mockResolvedValue({
      remainingMicroUsd: usd(1),
      usageKnown: true,
      usageMicroUsd: usd(1),
    });
    await expect(caller.getManagedProviderStatus()).resolves.toMatchObject({ hasCredit: true });
  });

  it.each([
    ['a deactivated budget', { isActive: false }],
    ['a failed renewal', { isActive: false, renewalStatus: 'renewal_failed' }],
    ['a pending renewal', { renewalStatus: 'renewal_pending' }],
  ])('shows no spendable org credit for %s', async (_label, state) => {
    h.shared = true;
    const org = await seedKeylessBudget();
    await testDB.update(memberBudgets).set(state).where(eq(memberBudgets.orgId, org.id));
    const caller = aicoBillingRouter.createCaller(createTestContext(userId));

    const sources = await caller.getMyBillingSources();
    const source = sources.sources.find(
      (s) => s.source === 'organization' && s.organizationId === org.id,
    )!;

    expect(source.remainingMicroUsd).toBe('0');
    expect(source.remainingPi).toBe('0');
    expect(source.remainingUsd).toBe('0.000000');
  });

  it('does not count a budget fully committed to open holds as org credit', async () => {
    const org = await seedKeylessBudget();
    await testDB
      .update(memberBudgets)
      .set({ heldMicroUsd: usd(4) })
      .where(eq(memberBudgets.orgId, org.id));
    const caller = aicoBillingRouter.createCaller(createTestContext(userId));

    await expect(caller.getManagedProviderStatus()).resolves.toMatchObject({ hasCredit: false });
  });

  it.each([
    ['provider capacity exhaustion', new ManagedKeyCapacityError(), 'PROVIDER_CAPACITY'],
    ['an unreachable provider', new Error('Control plane proxy 500'), 'PROVIDER_UNAVAILABLE'],
  ])('surfaces %s instead of a silent keyPending', async (_label, failure, code) => {
    const org = await seedKeylessBudget();
    await testDB
      .update(memberBudgets)
      .set({ isActive: true })
      .where(eq(memberBudgets.orgId, org.id));
    h.ensureMemberKey.mockRejectedValueOnce(failure);
    const caller = aicoBillingRouter.createCaller(createTestContext(userId));

    const sources = await caller.getMyBillingSources();
    const source = sources.sources.find(
      (s) => s.source === 'organization' && s.organizationId === org.id,
    )!;
    if (source.source !== 'organization') throw new Error('expected an organization source');

    expect(h.ensureMemberKey).toHaveBeenCalled();
    expect(source.hasManagedKey).toBe(false);
    expect(source.remainingMicroUsd).toBe(String(usd(2.5)));
    expect(source.keyProvisionError).toBe(code);
  });
});
