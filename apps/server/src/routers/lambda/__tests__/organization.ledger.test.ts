// @vitest-environment node
import type { LobeChatDatabase } from '@lobechat/database';
import { getTestDB } from '@lobechat/database/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { cleanupAicoTables, seedUsers } from '@/database/models/__tests__/aico.phase2.helpers';
import { OrganizationModel } from '@/database/models/organization';
import {
  memberBudgets,
  platformAdminUsers,
  userWallets,
} from '@/database/schemas/aicoOrganization';

import { organizationRouter } from '../organization';
import { platformAdminRouter } from '../platformAdmin';
import { createAdminContext, createTestContext } from './integration/setup';

let testDB: LobeChatDatabase;
vi.mock('@/database/core/db-adaptor', () => ({
  getServerDB: vi.fn(() => testDB),
}));

vi.mock('@/server/services/email', () => ({
  EmailService: class {
    sendMail = vi.fn().mockResolvedValue(undefined);
  },
}));

vi.mock('@/server/services/sms', () => ({
  SmsService: class {
    sendSms = vi.fn().mockResolvedValue(undefined);
  },
}));

const h = vi.hoisted(() => ({
  authoritative: false,
  ensureMemberKey: vi.fn(),
  reclaimMemberKey: vi.fn(),
  shared: false,
}));

vi.mock('@/server/services/aico/ledger/config', () => ({
  isSharedInferenceKey: () => h.shared,
}));

vi.mock('@/server/services/aico/ledger/state', () => ({
  isLedgerAuthoritative: async () => h.authoritative,
  isLedgerPaused: async () => false,
}));

vi.mock('@/server/services/openrouter/keyService', () => ({
  AicoOpenRouterKeyService: class {
    ensureMemberKey = h.ensureMemberKey;
    reclaimMemberKey = h.reclaimMemberKey;
  },
}));

const ownerId = 'ledger-org-router-owner';
const operatorId = 'ledger-org-router-operator';
const usd = (n: number) => Math.round(n * 1_000_000);

beforeEach(async () => {
  h.authoritative = false;
  h.shared = false;
  h.ensureMemberKey.mockReset().mockResolvedValue({ created: false, keyId: null });
  // The key estimate claims the whole $5 cap is unspent.
  h.reclaimMemberKey.mockReset().mockResolvedValue({ remainingMicroUsd: usd(5), usageMicroUsd: 0 });
  testDB = await getTestDB();
  await testDB.delete(platformAdminUsers);
  await cleanupAicoTables(testDB);
  await seedUsers(testDB, [{ email: 'ledger-org-router@example.com', id: ownerId }]);
});

/** A keyless $5 budget with $1 settled and $1.5 held on an org the user owns. */
const seedBudget = async () => {
  const orgModel = new OrganizationModel(testDB);
  const org = await orgModel.createOrganization({
    name: 'Ledger Org Router',
    ownerUserId: ownerId,
  });
  const me = (await orgModel.listMembers(org.id)).find((m) => m.userId === ownerId)!;
  await testDB.insert(memberBudgets).values({
    heldMicroUsd: usd(1.5),
    orgId: org.id,
    orgMemberId: me.id,
    periodAmountMicroUsd: usd(5),
    settledUsageMicroUsd: usd(1),
  });
  return { orgId: org.id, orgMemberId: me.id, orgModel };
};

describe('organization router under the usage ledger', () => {
  it('reports a keyless member budget as usable only under the shared key', async () => {
    const { orgId, orgMemberId } = await seedBudget();
    const caller = organizationRouter.createCaller(createTestContext(ownerId));

    expect((await caller.getMemberBudget({ orgId, orgMemberId }))?.hasManagedKey).toBe(false);
    h.shared = true;
    expect((await caller.getMemberBudget({ orgId, orgMemberId }))?.hasManagedKey).toBe(true);
  });

  it('revokes a budget crediting cycle minus settled minus held, not the key estimate', async () => {
    h.authoritative = true;
    const { orgId, orgMemberId, orgModel } = await seedBudget();
    const before = Number((await orgModel.getById(orgId))!.walletBalanceMicroUsd);
    const caller = organizationRouter.createCaller(createTestContext(ownerId));

    await caller.revokeMemberBudget({ orgId, orgMemberId });

    const after = Number((await orgModel.getById(orgId))!.walletBalanceMicroUsd);
    expect(after - before).toBe(usd(2.5));
  });

  it('allocateMemberCredit reports a key-mint failure instead of throwing after commit', async () => {
    const orgModel = new OrganizationModel(testDB);
    const org = await orgModel.createOrganization({ name: 'Key Fail Co', ownerUserId: ownerId });
    await orgModel.addManualCredit({
      amountMicroUsd: usd(10),
      amountToman: 500_000,
      createdByUserId: ownerId,
      description: 'fund',
      fxRateTomanPerUsd: 50_000,
      orgId: org.id,
      type: 'topup',
    });
    const me = (await orgModel.listMembers(org.id)).find((m) => m.userId === ownerId)!;
    h.ensureMemberKey.mockRejectedValueOnce(new Error('Control plane proxy 500'));
    const caller = organizationRouter.createCaller(createTestContext(ownerId));

    const result = await caller.allocateMemberCredit({
      amountMicroUsd: String(usd(5)),
      orgId: org.id,
      orgMemberId: me.id,
      period: 'monthly',
    });

    expect(result.keyProvisioned).toBe(false);
    expect(result.keyProvisionError).toBe('PROVIDER_UNAVAILABLE');
    // The quota landed despite the key failure — no silent double-allocate trap.
    const budget = await orgModel.getMemberBudgetForOrg({ orgId: org.id, orgMemberId: me.id });
    expect(Number(budget?.periodAmountMicroUsd)).toBe(usd(5));
  });
});

describe('platform admin router under the shared key', () => {
  it('lists a keyless wallet as having a managed key', async () => {
    await testDB.insert(platformAdminUsers).values({
      email: 'operator@ledger.test',
      id: operatorId,
      passwordHash: 'unusable:test',
    });
    await testDB.insert(userWallets).values({ balanceMicroUsd: usd(1), userId: ownerId });
    const caller = platformAdminRouter.createCaller(createAdminContext(operatorId));

    const row = () => caller.listUserWallets().then((w) => w.find((r) => r.userId === ownerId));
    expect((await row())?.hasManagedKey).toBe(false);
    h.shared = true;
    expect((await row())?.hasManagedKey).toBe(true);
  });
});
