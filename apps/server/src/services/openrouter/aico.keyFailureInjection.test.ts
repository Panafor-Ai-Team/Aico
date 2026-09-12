/**
 * Aico Phase 2 — OpenRouter failure injection + key lifecycle
 * Maps: AICO-P1-004, AICO-P1-011, AICO-P1-016, split-brain states
 */
// @vitest-environment node
import type { LobeChatDatabase } from '@lobechat/database';
import { getTestDB } from '@lobechat/database/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AicoBillingModel } from '@/database/models/aicoBilling';
import { users } from '@/database/schemas';
import {
  memberBudgets,
  organizationMembers,
  organizations,
  organizationTeamMembers,
  organizationTeams,
  userWallets,
  walletTransactions,
} from '@/database/schemas/aicoOrganization';
import { AicoOpenRouterKeyService } from '@/server/services/openrouter/keyService';
import type { OpenRouterManagementClient } from '@/server/services/openrouter/management';
import {
  __resetOpenRouterManagementClientForTests,
  createOpenRouterManagementClient,
} from '@/server/services/openrouter/management';

const FAKE_SECRET = 'sk-or-v1-FAKESECRET-PHASE2-LEAK-PROBE-0001';

class ControllableOpenRouterClient implements OpenRouterManagementClient {
  keys = new Map<string, any>();
  mode:
    | 'success'
    | 'timeout'
    | 'http400'
    | 'http401'
    | 'http403'
    | 'http409'
    | 'http429'
    | 'http500'
    | 'malformed'
    | 'missingKey'
    | 'slow'
    | 'updateFail'
    | 'disableFail' = 'success';

  createKey: OpenRouterManagementClient['createKey'] = async (params) => {
    if (this.mode === 'timeout') {
      await new Promise((_, rej) => setTimeout(() => rej(new Error('OpenRouter timeout')), 5));
      throw new Error('unreachable');
    }
    if (this.mode === 'slow') {
      await new Promise((r) => setTimeout(r, 30));
    }
    if (this.mode.startsWith('http')) {
      throw new Error(`OpenRouter HTTP ${this.mode.slice(4)}`);
    }
    if (this.mode === 'malformed') {
      return { hash: 'x', limit: params.limitUsd } as any;
    }
    if (this.mode === 'missingKey') {
      return {
        disabled: false,
        hash: `mock_${crypto.randomUUID().slice(0, 8)}`,
        // key intentionally missing
        limit: params.limitUsd,
        limitRemaining: params.limitUsd,
        name: params.name,
        usage: 0,
        usageDaily: 0,
        usageMonthly: 0,
        usageWeekly: 0,
      } as any;
    }
    const hash = `ctrl_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
    const row = {
      disabled: false,
      hash,
      key: `${FAKE_SECRET}-${hash}`,
      limit: params.limitUsd,
      limitRemaining: params.limitUsd,
      name: params.name,
      usage: 0,
      usageDaily: 0,
      usageMonthly: 0,
      usageWeekly: 0,
    };
    this.keys.set(hash, row);
    return { ...row };
  };

  getKey: OpenRouterManagementClient['getKey'] = async (hash) => {
    const row = this.keys.get(hash);
    if (!row) throw new Error('not found');
    const { key: _k, ...info } = row;
    return info;
  };

  updateKey: OpenRouterManagementClient['updateKey'] = async (params) => {
    if (this.mode === 'updateFail' || this.mode === 'disableFail') {
      throw new Error('OpenRouter update failed');
    }
    const row = this.keys.get(params.hash);
    if (!row) throw new Error('not found');
    if (params.disabled !== undefined) row.disabled = params.disabled;
    if (params.limitUsd !== undefined) row.limit = params.limitUsd;
    const { key: _k, ...info } = row;
    return info;
  };

  deleteKey: OpenRouterManagementClient['deleteKey'] = async (hash) => {
    this.keys.delete(hash);
  };
}

process.env.KEY_VAULTS_SECRET = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';

let db: LobeChatDatabase;
const userId = 'p2-or-user';

beforeEach(async () => {
  __resetOpenRouterManagementClientForTests();
  db = await getTestDB();
  await db.delete(walletTransactions);
  await db.delete(memberBudgets);
  await db.delete(organizationTeamMembers);
  await db.delete(organizationTeams);
  await db.delete(organizationMembers);
  await db.delete(organizations);
  await db.delete(userWallets);
  await db.delete(users);
  await db.insert(users).values({ email: 'or@example.com', id: userId });
}, 60_000);

afterEach(async () => {
  vi.restoreAllMocks();
  __resetOpenRouterManagementClientForTests();
});

describe('Aico OpenRouter failure injection (Phase 2)', () => {
  it('AICO-P1-004: missing management key fails closed in production (never silently mocks)', () => {
    const prevMock = process.env.AICO_OPENROUTER_MOCK;
    const prevKey = process.env.OPENROUTER_MANAGEMENT_API_KEY;
    const prevNode = process.env.NODE_ENV;
    try {
      delete process.env.OPENROUTER_MANAGEMENT_API_KEY;
      delete process.env.AICO_OPENROUTER_MOCK;
      // Simulate production-like
      (process.env as any).NODE_ENV = 'production';
      __resetOpenRouterManagementClientForTests();

      // Product server in production must require control plane (or refuse), never mock.
      expect(() => createOpenRouterManagementClient({})).toThrow(
        /AICO_CONTROL_PLANE_URL|OPENROUTER_MANAGEMENT_API_KEY/,
      );
    } finally {
      process.env.AICO_OPENROUTER_MOCK = prevMock;
      process.env.OPENROUTER_MANAGEMENT_API_KEY = prevKey;
      (process.env as any).NODE_ENV = prevNode;
      __resetOpenRouterManagementClientForTests();
    }
  });

  it('AICO-P1-004: forceMock still works for tests regardless of NODE_ENV', () => {
    const client = createOpenRouterManagementClient({ forceMock: true });
    expect(client.constructor.name).toContain('Mock');
  });

  it('DB succeeds, OpenRouter create fails — wallet credit remains, no key id (split-brain credit)', async () => {
    const billing = new AicoBillingModel(db);
    const client = new ControllableOpenRouterClient();
    client.mode = 'http500';
    const keys = new AicoOpenRouterKeyService(db, client);

    await billing.manualCreditUser({
      amountMicroUsd: 10_000_000,
      amountToman: 50_000,
      createdByUserId: userId,
      fxRateTomanPerUsd: 5000,
      userId,
    });

    await expect(keys.ensureUserKey(userId)).rejects.toThrow(/500|OpenRouter/);
    const wallet = await billing.getUserWallet(userId);
    expect(Number(wallet?.balanceMicroUsd) / 1_000_000).toBe(10);
    expect(wallet?.openrouterKeyId).toBeFalsy();
  });

  it('AICO-P1-011: concurrent ensureUserKey can create orphan OpenRouter keys', async () => {
    const billing = new AicoBillingModel(db);
    const client = new ControllableOpenRouterClient();
    const keys = new AicoOpenRouterKeyService(db, client);

    await billing.manualCreditUser({
      amountMicroUsd: 10_000_000,
      amountToman: 50_000,
      createdByUserId: userId,
      fxRateTomanPerUsd: 5000,
      userId,
    });

    // Slow creates so both see empty keyId
    client.mode = 'slow';
    await Promise.all([keys.ensureUserKey(userId), keys.ensureUserKey(userId)]);

    expect(client.keys.size).toBe(1);
    const wallet = await billing.getUserWallet(userId);
    expect(wallet?.openrouterKeyId).toBeTruthy();
  });

  it('AICO-P1-016: ensureMemberKey floors new keys at $0.01 even for zero budget', async () => {
    // Setup org member budget with limit 0 via direct insert path after org scaffolding
    const { OrganizationModel } = await import('@/database/models/organization');
    const orgModel = new OrganizationModel(db);
    const org = await orgModel.createOrganization({ name: 'Zero Budget', ownerUserId: userId });
    const members = await orgModel.listMembers(org.id);
    const ownerMember = members[0];

    // Insert zero budget directly
    await db.insert(memberBudgets).values({
      isActive: true,
      orgId: org.id,
      orgMemberId: ownerMember.id,
      period: 'daily',
      periodAmountMicroUsd: 0,
      reservedMicroUsd: 0,
    });

    const client = new ControllableOpenRouterClient();
    const keys = new AicoOpenRouterKeyService(db, client);
    await keys.ensureMemberKey(ownerMember.id);

    expect(client.keys.size).toBe(0); // must not create key for zero budget
  });

  it('OR-002: OpenRouter succeeds then DB key update failure retires orphan key', async () => {
    const billing = new AicoBillingModel(db);
    const client = new ControllableOpenRouterClient();
    const keys = new AicoOpenRouterKeyService(db, client);

    await billing.manualCreditUser({
      amountMicroUsd: 10_000_000,
      amountToman: 50_000,
      createdByUserId: userId,
      fxRateTomanPerUsd: 5000,
      userId,
    });

    // Class-field method lives on the instance created inside the service.
    (keys as any).billingModel.updateUserOpenRouterKey = async () => {
      throw new Error('DB write failed');
    };

    await expect(keys.ensureUserKey(userId)).rejects.toThrow(/DB write failed/);
    expect(client.keys.size).toBe(0); // OR-002: orphan retired (disable+delete)
    const wallet = await billing.getUserWallet(userId);
    expect(wallet?.openrouterKeyId).toBeFalsy();
  });

  it('ciphertext corruption: decrypt fails closed (null or throw, never garbage key)', async () => {
    const billing = new AicoBillingModel(db);
    await billing.manualCreditUser({
      amountMicroUsd: 10_000_000,
      amountToman: 50_000,
      createdByUserId: userId,
      fxRateTomanPerUsd: 5000,
      userId,
    });
    await billing.updateUserOpenRouterKey({
      // The field is `ciphertext`; `encryptedKey` was silently dropped, so the
      // corrupt value never reached the wallet this test is probing.
      ciphertext: 'not-valid-ciphertext',
      keyId: 'corrupt-id',
      userId,
    });

    const client = new ControllableOpenRouterClient();
    const keys = new AicoOpenRouterKeyService(db, client);
    let resolved: string | null = null;
    let threw = false;
    try {
      resolved = await keys.resolveUserApiKey(userId);
    } catch {
      threw = true;
    }
    expect(threw || resolved === null).toBe(true);
    if (resolved) expect(resolved.startsWith('sk-')).toBe(false);
  });

  it('reclaimMemberKey returns limitRemaining and disables the key (never leaves it spendable)', async () => {
    const { OrganizationModel } = await import('@/database/models/organization');
    const orgModel = new OrganizationModel(db);
    const org = await orgModel.createOrganization({ name: 'Reclaim Org', ownerUserId: userId });
    const members = await orgModel.listMembers(org.id);
    const ownerMember = members[0];

    const client = new ControllableOpenRouterClient();
    const keys = new AicoOpenRouterKeyService(db, client);

    await db.insert(memberBudgets).values({
      isActive: true,
      orgId: org.id,
      orgMemberId: ownerMember.id,
      period: 'daily',
      periodAmountMicroUsd: 20_000_000,
      reservedMicroUsd: 20_000_000,
    });
    await keys.ensureMemberKey(ownerMember.id);
    const budget = await orgModel.getMemberBudget(ownerMember.id);
    const keyHash = budget!.openrouterKeyId!;
    // Simulate partial spend as OpenRouter would report it. The key limit is
    // the raw $20 / 1.2 the budget buys, so raw spend and raw remaining both
    // convert back to billed amounts that add up to the $20 cap.
    const key = client.keys.get(keyHash);
    // A daily budget is metered on OpenRouter's daily counter, so move both.
    key.usage = 8;
    key.usageDaily = 8;
    key.limitRemaining = key.limit - key.usage;

    const reclaimed = await keys.reclaimMemberKey({
      orgId: org.id,
      orgMemberId: ownerMember.id,
    });
    expect(reclaimed).toEqual({ remainingMicroUsd: 10_400_000, usageMicroUsd: 9_600_000 });
    expect(client.keys.get(keyHash).disabled).toBe(true);

    // Reclaiming again after disable must not throw or double-count.
    const reclaimedAgain = await keys.reclaimMemberKey({
      orgId: org.id,
      orgMemberId: ownerMember.id,
    });
    expect(reclaimedAgain?.remainingMicroUsd).toBe(10_400_000);
  });

  it('disableAllOrgMemberKeys disables every member key in the org (suspend safety)', async () => {
    const { OrganizationModel } = await import('@/database/models/organization');
    const orgModel = new OrganizationModel(db);
    const org = await orgModel.createOrganization({ name: 'Suspend Org', ownerUserId: userId });
    const members = await orgModel.listMembers(org.id);
    const ownerMember = members[0];

    const client = new ControllableOpenRouterClient();
    const keys = new AicoOpenRouterKeyService(db, client);
    await db.insert(memberBudgets).values({
      isActive: true,
      orgId: org.id,
      orgMemberId: ownerMember.id,
      period: 'daily',
      periodAmountMicroUsd: 10_000_000,
      reservedMicroUsd: 10_000_000,
    });
    await keys.ensureMemberKey(ownerMember.id);
    const budget = await orgModel.getMemberBudget(ownerMember.id);
    expect(client.keys.get(budget!.openrouterKeyId!).disabled).toBe(false);

    await keys.disableAllOrgMemberKeys(org.id);

    expect(client.keys.get(budget!.openrouterKeyId!).disabled).toBe(true);
  });

  it('reclaimMemberKey returns null when the member has no managed key', async () => {
    const { OrganizationModel } = await import('@/database/models/organization');
    const orgModel = new OrganizationModel(db);
    const org = await orgModel.createOrganization({ name: 'No Key Org', ownerUserId: userId });
    const members = await orgModel.listMembers(org.id);
    const client = new ControllableOpenRouterClient();
    const keys = new AicoOpenRouterKeyService(db, client);

    const reclaimed = await keys.reclaimMemberKey({
      orgId: org.id,
      orgMemberId: members[0].id,
    });
    expect(reclaimed).toBeNull();
  });

  it('AICO-P1 secret: ensureUserKey never returns plaintext key to caller', async () => {
    const billing = new AicoBillingModel(db);
    const client = new ControllableOpenRouterClient();
    const keys = new AicoOpenRouterKeyService(db, client);
    await billing.manualCreditUser({
      amountMicroUsd: 10_000_000,
      amountToman: 50_000,
      createdByUserId: userId,
      fxRateTomanPerUsd: 5000,
      userId,
    });
    const result = await keys.ensureUserKey(userId);
    expect(JSON.stringify(result)).not.toContain(FAKE_SECRET);
    expect(result).not.toHaveProperty('key');
  });

  it('FIN-001: ensureMemberKey OR limit uses periodAmount, not reserved with pending', async () => {
    const { OrganizationModel } = await import('@/database/models/organization');
    const orgModel = new OrganizationModel(db);
    const org = await orgModel.createOrganization({
      name: 'Pending Limit Org',
      ownerUserId: userId,
    });
    const members = await orgModel.listMembers(org.id);
    const ownerMember = members[0];

    const client = new ControllableOpenRouterClient();
    const keys = new AicoOpenRouterKeyService(db, client);

    await db.insert(memberBudgets).values({
      isActive: true,
      orgId: org.id,
      orgMemberId: ownerMember.id,
      pendingPeriod: 'monthly',
      pendingPeriodAmountMicroUsd: 30_000_000,
      period: 'daily',
      periodAmountMicroUsd: 10_000_000,
      reservedMicroUsd: 40_000_000,
    });

    await keys.ensureMemberKey(ownerMember.id);
    const budget = await orgModel.getMemberBudget(ownerMember.id);
    const key = client.keys.get(budget!.openrouterKeyId!);
    // Must be current-cycle $10, not reserved $40 — divided by the 1.2x
    // platform multiplier, since the cycle cap is a billed amount.
    expect(key.limit).toBeCloseTo(8.333_333, 6);
  });

  it('syncMemberCycleUsage writes period usage, not lifetime OpenRouter usage', async () => {
    const { OrganizationModel } = await import('@/database/models/organization');
    const orgModel = new OrganizationModel(db);
    const org = await orgModel.createOrganization({
      name: 'Cycle Sync Org',
      ownerUserId: userId,
    });
    const members = await orgModel.listMembers(org.id);
    const ownerMember = members[0];

    const client = new ControllableOpenRouterClient();
    const keys = new AicoOpenRouterKeyService(db, client);

    await db.insert(memberBudgets).values({
      isActive: true,
      openrouterKeyCiphertext: 'enc',
      openrouterKeyId: 'ctrl_cycle_sync',
      orgId: org.id,
      orgMemberId: ownerMember.id,
      period: 'daily',
      periodAmountMicroUsd: 10_000_000,
      reservedMicroUsd: 10_000_000,
      settledUsageMicroUsd: 0,
    });

    client.keys.set('ctrl_cycle_sync', {
      disabled: false,
      hash: 'ctrl_cycle_sync',
      key: `${FAKE_SECRET}-ctrl_cycle_sync`,
      limit: 10,
      limitRemaining: 8,
      name: 'test',
      usage: 50,
      usageDaily: 2,
      usageMonthly: 50,
      usageWeekly: 50,
    });

    await keys.syncMemberCycleUsage(ownerMember.id);
    const budget = await orgModel.getMemberBudget(ownerMember.id);
    // Daily raw usage of $2 (not the $50 lifetime figure), billed at 1.2x.
    expect(budget!.settledUsageMicroUsd).toBe(2_400_000);
  });

  describe('FIN-014 a missing period counter must never fall back to lifetime usage', () => {
    const seedDailyBudget = async (
      keyId: string,
      keyInfo: Record<string, unknown>,
      budgetOverrides: Record<string, unknown> = {},
    ) => {
      const { OrganizationModel } = await import('@/database/models/organization');
      const orgModel = new OrganizationModel(db);
      const org = await orgModel.createOrganization({
        name: `FIN014 ${keyId}`,
        ownerUserId: userId,
      });
      const members = await orgModel.listMembers(org.id);
      const ownerMember = members[0];

      const client = new ControllableOpenRouterClient();
      const keys = new AicoOpenRouterKeyService(db, client);

      await db.insert(memberBudgets).values({
        isActive: true,
        openrouterKeyCiphertext: 'enc',
        openrouterKeyId: keyId,
        orgId: org.id,
        orgMemberId: ownerMember.id,
        period: 'daily',
        periodAmountMicroUsd: 10_000_000,
        reservedMicroUsd: 10_000_000,
        settledUsageMicroUsd: 0,
        ...budgetOverrides,
      });

      client.keys.set(keyId, {
        disabled: false,
        hash: keyId,
        key: `${FAKE_SECRET}-${keyId}`,
        limit: 10,
        name: 'test',
        ...keyInfo,
      });

      return { client, keys, orgModel, ownerMember };
    };

    it('does not stamp the checkpoint baseline with lifetime usage, so the key limit stays at the funded cap', async () => {
      // A stale checkpoint rate forces the rebase path, and OpenRouter reports
      // no daily counter. Before the fix the $500 lifetime figure became the
      // baseline, and the key was then pushed a $500 limit against a $10/day cap.
      const { client, keys, orgModel, ownerMember } = await seedDailyBudget(
        'ctrl_fin014_rebase',
        { limitRemaining: 8, usage: 500, usageDaily: null, usageMonthly: null, usageWeekly: null },
        { checkpointMultiplierBp: 11_000 },
      );

      await keys.syncMemberCycleUsage(ownerMember.id);

      const budget = await orgModel.getMemberBudget(ownerMember.id);
      expect(Number(budget!.usageBaselineMicroUsd ?? 0)).toBe(0);
      expect(Number(budget!.checkpointMultiplierBp)).toBe(11_000);

      await keys.ensureMemberKey(ownerMember.id);
      const key = client.keys.get('ctrl_fin014_rebase');
      // $10 cycle cap ÷ the 1.2x platform multiplier — never the lifetime figure.
      expect(key.limit).toBeCloseTo(8.333_333, 6);
      expect(key.limit).toBeLessThan(10);
    });

    it('holds settled usage at the last known value instead of saturating the cap', async () => {
      // Neither `limit_remaining` nor a period counter is available. Converting
      // lifetime usage here would bill $50 against a $10 cap, clamp to the cap
      // and strand the member for the rest of the day.
      const { keys, orgModel, ownerMember } = await seedDailyBudget(
        'ctrl_fin014_settle',
        {
          limitRemaining: null,
          usage: 50,
          usageDaily: null,
          usageMonthly: null,
          usageWeekly: null,
        },
        { settledUsageMicroUsd: 1_000_000 },
      );

      await keys.syncMemberCycleUsage(ownerMember.id);

      const budget = await orgModel.getMemberBudget(ownerMember.id);
      expect(Number(budget!.settledUsageMicroUsd)).toBe(1_000_000);
    });

    it('records the degraded sync so the gap is visible to operators', async () => {
      const { keys, orgModel, ownerMember } = await seedDailyBudget(
        'ctrl_fin014_status',
        { limitRemaining: 8, usage: 500, usageDaily: null, usageMonthly: null, usageWeekly: null },
        { checkpointMultiplierBp: 11_000 },
      );

      await keys.syncMemberCycleUsage(ownerMember.id);

      const budget = await orgModel.getMemberBudget(ownerMember.id);
      expect(budget!.lastSyncStatus).toBe('degraded');
      expect(budget!.lastSyncError).toMatch(/period usage counter/i);
    });

    it('still reads the lifetime counter for a legacy total budget', async () => {
      // `total` budgets are created without `limit_reset`, so OpenRouter meters
      // them on the lifetime counter and it remains the correct source.
      const { keys, orgModel, ownerMember } = await seedDailyBudget(
        'ctrl_fin014_total',
        { limitRemaining: null, usage: 2, usageDaily: null, usageMonthly: null, usageWeekly: null },
        { period: 'total', settledUsageMicroUsd: 0 },
      );

      await keys.syncMemberCycleUsage(ownerMember.id);

      const budget = await orgModel.getMemberBudget(ownerMember.id);
      expect(Number(budget!.settledUsageMicroUsd)).toBe(2_400_000);
      expect(budget!.lastSyncStatus).toBe('synced');
    });

    it('still uses the period counter when OpenRouter reports one', async () => {
      const { keys, orgModel, ownerMember } = await seedDailyBudget('ctrl_fin014_happy', {
        limitRemaining: 8,
        usage: 50,
        usageDaily: 2,
        usageMonthly: 50,
        usageWeekly: 50,
      });

      await keys.syncMemberCycleUsage(ownerMember.id);

      const budget = await orgModel.getMemberBudget(ownerMember.id);
      expect(Number(budget!.settledUsageMicroUsd)).toBe(2_400_000);
      expect(budget!.lastSyncStatus).toBe('synced');
    });
  });

  it('FIN-004: recreate after 404 disables/deletes the stale key hash', async () => {
    const billing = new AicoBillingModel(db);
    const client = new ControllableOpenRouterClient();
    const keys = new AicoOpenRouterKeyService(db, client);

    await billing.manualCreditUser({
      amountMicroUsd: 10_000_000,
      amountToman: 50_000,
      createdByUserId: userId,
      fxRateTomanPerUsd: 5000,
      userId,
    });
    await keys.ensureUserKey(userId);
    const wallet = await billing.getUserWallet(userId);
    const staleHash = wallet!.openrouterKeyId!;
    expect(client.keys.has(staleHash)).toBe(true);

    // Next update looks like a vanished remote key — recreate path.
    client.updateKey = async () => {
      throw new Error('OpenRouter Management API 404: key not found');
    };

    await keys.ensureUserKey(userId);
    expect(client.keys.has(staleHash)).toBe(false);
    const after = await billing.getUserWallet(userId);
    expect(after?.openrouterKeyId).toBeTruthy();
    expect(after?.openrouterKeyId).not.toBe(staleHash);
  });
});
