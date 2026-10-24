// @vitest-environment node
import type { LobeChatDatabase } from '@lobechat/database';
import { getTestDB } from '@lobechat/database/test-utils';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { cleanupAicoTables, seedUsers } from '@/database/models/__tests__/aico.phase2.helpers';
import { AicoUsageLedgerModel } from '@/database/models/aicoUsageLedger';
import { OrganizationModel } from '@/database/models/organization';
import { users } from '@/database/schemas';
import {
  aicoKeyOutbox,
  memberBudgets,
  platformAdminUsers,
  userWallets,
  walletTransactions,
} from '@/database/schemas/aicoOrganization';
import { microUsdToDecimalString } from '@/database/utils/aicoMoney';

import { aicoBillingRouter } from '../aicoBilling';
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

  it('D3: a key push that failed or could not be verified is queued for retry', async () => {
    const orgModel = new OrganizationModel(testDB);
    const org = await orgModel.createOrganization({ name: 'Retry Co', ownerUserId: ownerId });
    await orgModel.addManualCredit({
      amountMicroUsd: usd(20),
      amountToman: 1_000_000,
      createdByUserId: ownerId,
      description: 'fund',
      fxRateTomanPerUsd: 50_000,
      orgId: org.id,
      type: 'topup',
    });
    const me = (await orgModel.listMembers(org.id)).find((m) => m.userId === ownerId)!;
    const caller = organizationRouter.createCaller(createTestContext(ownerId));
    const allocate = (amountUsd: number) =>
      caller.allocateMemberCredit({
        amountMicroUsd: String(usd(amountUsd)),
        orgId: org.id,
        orgMemberId: me.id,
        period: 'monthly',
      });
    const queued = () =>
      testDB.query.aicoKeyOutbox.findMany({ where: eq(aicoKeyOutbox.orgMemberId, me.id) });

    h.ensureMemberKey.mockResolvedValueOnce({ created: false, keyId: 'k1' });
    await allocate(5);
    expect(await queued()).toHaveLength(0);

    h.ensureMemberKey.mockRejectedValueOnce(new Error('Control plane proxy 500'));
    await allocate(6);
    h.ensureMemberKey.mockResolvedValueOnce({ created: false, keyId: 'k1', unverified: true });
    await allocate(7);

    const rows = await queued();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.action === 'sync_member_key' && r.status === 'pending')).toBe(true);
    expect(rows[0].orgId).toBe(org.id);
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

  it('N12: a placeholder key id is not listed as a provisioned key', async () => {
    await testDB.insert(platformAdminUsers).values({
      email: 'operator-n12@ledger.test',
      id: operatorId,
      passwordHash: 'unusable:test',
    });
    await testDB
      .insert(userWallets)
      .values({ balanceMicroUsd: usd(1), openrouterKeyId: 'mock_placeholder_1', userId: ownerId });
    const caller = platformAdminRouter.createCaller(createAdminContext(operatorId));

    const row = (await caller.listUserWallets()).find((r) => r.userId === ownerId);

    expect(row?.hasManagedKey).toBe(false);
  });

  it('C6: platform totals cover every wallet and transaction, not the newest 200', async () => {
    await testDB.insert(platformAdminUsers).values({
      email: 'operator-totals@ledger.test',
      id: operatorId,
      passwordHash: 'unusable:test',
    });
    const count = 205;
    const ids = Array.from({ length: count }, (_, i) => `c6-user-${i}`);
    await testDB.insert(users).values(ids.map((id) => ({ email: `${id}@c6.test`, id })));
    await testDB.insert(userWallets).values(ids.map((userId) => ({ balanceMicroUsd: 2, userId })));
    await testDB.insert(walletTransactions).values(
      ids.map((userId) => ({
        amountMicroUsd: 3,
        amountToman: 5,
        type: 'topup',
        userId,
      })),
    );
    const caller = platformAdminRouter.createCaller(createAdminContext(operatorId));

    try {
      const totals = await caller.getPlatformFinancials();

      expect(totals.b2cWalletCount).toBe(count);
      expect(totals.b2cBalanceMicroUsd).toBe(String(count * 2));
      expect(totals.totalRevenueToman).toBe(String(count * 5));
      expect(totals.recentTransactions.length).toBeLessThanOrEqual(50);
    } finally {
      // Other files share this database; a failed assertion must not leave 205
      // wallets behind for them.
      await testDB.delete(walletTransactions);
      await testDB.delete(userWallets);
      await testDB.delete(users);
    }
  });
});

describe('N10: usage reports separate measured spend from an estimate', () => {
  const HOLD_RAW = 300_000;
  const USED_RAW = 50_000;
  // 1.2x, the multiplier the holds below are placed at.
  const billed = (raw: number) => Math.ceil((raw * 12_000) / 10_000);

  /** Two shadow calls for the owner: one measured, one aborted without a figure. */
  const seedShadowCalls = async () => {
    await testDB.insert(platformAdminUsers).values({
      email: 'operator-n10@ledger.test',
      id: operatorId,
      passwordHash: 'unusable:test',
    });
    await testDB.insert(userWallets).values({
      balanceMicroUsd: usd(9),
      rawCapacityMicroUsd: usd(8),
      userId: ownerId,
    });
    const ledger = new AicoUsageLedgerModel(testDB);
    for (const reason of ['usage', 'estimate_aborted'] as const) {
      const holdId = await ledger.recordShadowHold({
        billingSource: 'personal',
        estInputTokens: 1000,
        holdRawMicroUsd: HOLD_RAW,
        maxOpenHolds: 6,
        maxOutputTokens: 32_000,
        modelId: 'glm-5.3-flash',
        modelMultiplierBp: 10_000,
        multiplierBp: 12_000,
        operation: 'chat',
        pricedModelId: 'glm-5.3-flash',
        refuseReason: null,
        subject: { type: 'wallet', userId: ownerId },
        ttlSeconds: 900,
        wouldRefuse: false,
      });
      await ledger.settleHold(holdId, {
        ...(reason === 'usage' ? { chargedRawMicroUsd: USED_RAW } : {}),
        reason,
        tokens: { completion: 10, prompt: 20, reasoning: 0, total: 30 },
      });
    }
  };

  it('a user sees the metered cost, and the aborted call is marked as an estimate', async () => {
    await seedShadowCalls();
    const caller = aicoBillingRouter.createCaller(createTestContext(ownerId));

    const rows = await caller.getMyUsage();

    const measured = rows.find((r) => !r.costEstimated)!;
    const estimated = rows.find((r) => r.costEstimated)!;
    expect(measured.costMicroUsd).toBe(String(billed(USED_RAW)));
    expect(estimated.costMicroUsd).toBe('0');
    expect(estimated.settlementStatus).toBe('shadow');
  });

  it('platform cost and margin use measured spend; the estimate is reported apart', async () => {
    await seedShadowCalls();
    const caller = platformAdminRouter.createCaller(createAdminContext(operatorId));

    const totals = await caller.getPlatformFinancials();

    expect(totals.totalOpenRouterCostMicroUsd).toBe(String(billed(USED_RAW)));
    expect(totals.unmeasuredCostMicroUsd).toBe(String(billed(HOLD_RAW)));
  });

  it('the low-balance monitor keeps counting the upper bound', async () => {
    await seedShadowCalls();
    const caller = platformAdminRouter.createCaller(createAdminContext(operatorId));

    const status = await caller.getMasterAccountStatus();

    expect(status.totalObservedUsageUsd).toBe(
      microUsdToDecimalString(billed(USED_RAW) + billed(HOLD_RAW)),
    );
  });
});
