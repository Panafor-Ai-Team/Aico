/**
 * Aico Phase 2 — Chat-path bypass, production safety, secret leak, trial fallthrough
 * Maps: AICO-P1-003, AICO-P1-009, AICO-P1-014, AICO-P1-015, secret hygiene
 */
// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { LobeChatDatabase } from '@lobechat/database';
import { getTestDB } from '@lobechat/database/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AicoBillingModel } from '@/database/models/aicoBilling';
import { OrganizationModel } from '@/database/models/organization';
import { users } from '@/database/schemas';
import {
  memberBudgets,
  modelAccessRules,
  organizationMembers,
  organizations,
  organizationTeamMembers,
  organizationTeams,
  platformTrialConfig,
  trialAbuseBlocklist,
  userTrials,
  userWallets,
  walletTransactions,
} from '@/database/schemas/aicoOrganization';
import { AicoChatGuard } from '@/server/services/aico/chatGuard';
import {
  __resetOpenRouterManagementClientForTests,
  createOpenRouterManagementClient,
} from '@/server/services/openrouter/management';
import { createSmsServiceImpl } from '@/server/services/sms/impls';

process.env.KEY_VAULTS_SECRET = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';

const REPO_ROOT = join(__dirname, '../../../../..'); // apps/server/src/services/aico → repo root

describe('Aico chat-path bypass probes (Phase 2)', () => {
  it('AICO-P1-009: managed runtime creation enforces the model allowlist centrally', () => {
    // Model access is enforced centrally: every managed runtime goes through
    // AicoManagedPolicy.authorize with the requested model, which refuses a missing model
    // id and checks it against grants / trial allowlists / the catalog (behaviour is
    // covered in managedPolicy.test.ts). Pin that wiring so a refactor cannot drop it.
    const runtime = readFileSync(
      join(REPO_ROOT, 'apps/server/src/modules/ModelRuntime/index.ts'),
      'utf8',
    );
    const policy = readFileSync(
      join(REPO_ROOT, 'apps/server/src/services/aico/managedPolicy.ts'),
      'utf8',
    );
    expect(runtime).toMatch(
      /if \(managed\) \{[\s\S]*?policy\.authorize\(\{[\s\S]*?modelId: options\??\.modelId/,
    );
    expect(policy).toMatch(/MODEL_ID_REQUIRED/);
    expect(policy).toMatch(/await this\.assertModelAllowed\(/);
  });

  it('AICO-P1-015: chat route must call recordUsage or syncMemberUsage', () => {
    const chatRoute = join(REPO_ROOT, 'src/app/(backend)/webapi/chat/[provider]/route.ts');
    const src = readFileSync(chatRoute, 'utf8');
    // `afterManagedChat` is the wiring point — it internally calls recordUsage +
    // syncMemberUsage (see chatGuard.ts), so either the direct calls or the
    // wrapper satisfy the invariant that usage bookkeeping is actually wired up.
    const wiresUsage =
      src.includes('recordUsage') ||
      src.includes('syncMemberUsage') ||
      src.includes('recordTrialRequest') ||
      src.includes('afterManagedChat');
    expect(wiresUsage).toBe(true);
  });
});

describe('AicoChatGuard trial fallthrough (Phase 2)', () => {
  let db: LobeChatDatabase;
  const userId = 'p2-guard-user';

  beforeEach(async () => {
    db = await getTestDB();
    await db.delete(trialAbuseBlocklist);
    await db.delete(userTrials);
    await db.delete(platformTrialConfig);
    await db.delete(walletTransactions);
    await db.delete(memberBudgets);
    await db.delete(modelAccessRules);
    await db.delete(organizationTeamMembers);
    await db.delete(organizationTeams);
    await db.delete(organizationMembers);
    await db.delete(organizations);
    await db.delete(userWallets);
    await db.delete(users);
    await db.insert(users).values({
      email: 'guard@example.com',
      id: userId,
      phone: '+989124444444',
      phoneNumberVerified: true,
    });
  }, 60_000);

  afterEach(async () => {
    await db.delete(trialAbuseBlocklist);
    await db.delete(userTrials);
    await db.delete(platformTrialConfig);
    await db.delete(walletTransactions);
    await db.delete(memberBudgets);
    await db.delete(modelAccessRules);
    await db.delete(organizationTeamMembers);
    await db.delete(organizationTeams);
    await db.delete(organizationMembers);
    await db.delete(organizations);
    await db.delete(userWallets);
    await db.delete(users);
  }, 60_000);

  it('AICO-P1-003: active trial without managed key denies (fail closed, never env key fallthrough)', async () => {
    const billing = new AicoBillingModel(db);
    await billing.updateTrialConfig({
      allowedModelIds: ['openai/gpt-4o-mini'],
      enabled: true,
      maxRequests: 10,
      updatedByUserId: userId,
    });
    await billing.activateTrial({ phone: '+989124444444', userId });

    const guard = new AicoChatGuard(db);
    // Invariant: must not fall through to shared env key — deny (throw) instead of
    // silently returning null (which the runtime would otherwise treat as "no
    // managed key" and could fall back to a shared env key).
    await expect(guard.resolveManagedApiKey(userId)).rejects.toThrow();
  });

  it('AICO-P1-009: team allow-list denies model', async () => {
    const orgModel = new OrganizationModel(db);
    const org = await orgModel.createOrganization({ name: 'Allow Org', ownerUserId: userId });
    const teams = await orgModel.listTeams(org.id);
    await orgModel.setTeamModelAccess({
      modelIds: ['openai/gpt-4o-mini'],
      orgId: org.id,
      teamId: teams[0].id,
    });

    const guard = new AicoChatGuard(db);
    await expect(guard.assertModelAllowed(userId, 'openai/gpt-4o')).rejects.toThrow(
      /MODEL_NOT_ALLOWED/,
    );
  });

  it('alternate model alias must not bypass trial allow-list', async () => {
    const billing = new AicoBillingModel(db);
    await billing.updateTrialConfig({
      allowedModelIds: ['openai/gpt-4o-mini'],
      enabled: true,
      maxRequests: 10,
      updatedByUserId: userId,
    });
    await billing.activateTrial({ phone: '+989124444444', userId });

    const guard = new AicoChatGuard(db);
    await expect(guard.assertModelAllowed(userId, 'gpt-4o-mini')).rejects.toThrow(
      /TRIAL_MODEL_NOT_ALLOWED/,
    );
    await expect(guard.assertModelAllowed(userId, 'openrouter/openai/gpt-4o-mini')).rejects.toThrow(
      /TRIAL_MODEL_NOT_ALLOWED/,
    );
  });
});

describe('Aico production safety (Phase 2)', () => {
  it('AICO-P1-014: missing KAVENEGAR_API_KEY fails closed in production (no Debug SMS)', () => {
    const prev = process.env.KAVENEGAR_API_KEY;
    const prevNode = process.env.NODE_ENV;
    try {
      delete process.env.KAVENEGAR_API_KEY;
      (process.env as any).NODE_ENV = 'production';
      expect(() => createSmsServiceImpl()).toThrow(/KAVENEGAR_API_KEY/);
    } finally {
      process.env.KAVENEGAR_API_KEY = prev;
      (process.env as any).NODE_ENV = prevNode;
    }
  });

  it('AICO-P1-004: createOpenRouterManagementClient without key throws in production (never mocks)', () => {
    const prev = process.env.OPENROUTER_MANAGEMENT_API_KEY;
    const prevMock = process.env.AICO_OPENROUTER_MOCK;
    const prevNode = process.env.NODE_ENV;
    try {
      delete process.env.OPENROUTER_MANAGEMENT_API_KEY;
      delete process.env.AICO_OPENROUTER_MOCK;
      (process.env as any).NODE_ENV = 'production';
      __resetOpenRouterManagementClientForTests();
      expect(() => createOpenRouterManagementClient({})).toThrow(/AICO_CONTROL_PLANE_URL/);
    } finally {
      process.env.OPENROUTER_MANAGEMENT_API_KEY = prev;
      process.env.AICO_OPENROUTER_MOCK = prevMock;
      (process.env as any).NODE_ENV = prevNode;
      __resetOpenRouterManagementClientForTests();
    }
  });

  it('AICO_OPENROUTER_MOCK is ignored in production — never silently mocks', () => {
    const prevKey = process.env.OPENROUTER_MANAGEMENT_API_KEY;
    const prevMock = process.env.AICO_OPENROUTER_MOCK;
    const prevNode = process.env.NODE_ENV;
    try {
      delete process.env.OPENROUTER_MANAGEMENT_API_KEY;
      process.env.AICO_OPENROUTER_MOCK = '1';
      (process.env as any).NODE_ENV = 'production';
      __resetOpenRouterManagementClientForTests();
      expect(() => createOpenRouterManagementClient({})).toThrow(/AICO_CONTROL_PLANE_URL/);
    } finally {
      process.env.OPENROUTER_MANAGEMENT_API_KEY = prevKey;
      process.env.AICO_OPENROUTER_MOCK = prevMock;
      (process.env as any).NODE_ENV = prevNode;
      __resetOpenRouterManagementClientForTests();
    }
  });

  it('tomanToUsd rejects non-positive FX rate', async () => {
    const { tomanToUsd } = await import('@/envs/aico');
    expect(() => tomanToUsd(1000, 0)).toThrow(/Invalid FX rate/i);
    expect(() => tomanToUsd(1000, -1)).toThrow(/Invalid FX rate/i);
  });
});

describe('Aico secret leak probes (Phase 2)', () => {
  it('getMyWallet response shape must not include key material fields', async () => {
    // Static contract from router source
    const routerPath = join(REPO_ROOT, 'apps/server/src/routers/lambda/aicoBilling.ts');
    const src = readFileSync(routerPath, 'utf8');
    expect(src).toContain('Never expose key material');
    expect(src).not.toMatch(/return \{[^}]*openrouterKeyHash/);
    expect(src).not.toMatch(/return \{[^}]*apiKey/);
  });

  it('AicoOpenRouterKeyService resolve is server-only and not mounted on aicoBilling router', () => {
    const routerPath = join(REPO_ROOT, 'apps/server/src/routers/lambda/aicoBilling.ts');
    const src = readFileSync(routerPath, 'utf8');
    expect(src).not.toContain('resolveUserApiKey');
    expect(src).not.toContain('decryptKey');
  });
});
