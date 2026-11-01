/**
 * AICO-P1-010 at the policy boundary: every managed call on an active Trial reserves one
 * request unit atomically, after every check that can refuse, and is refused with
 * `TRIAL_REQUEST_LIMIT` before any provider call once the platform cap is spent.
 */
import { OPENROUTER_AUTO_MODEL_ID } from '@lobechat/business-const';
import type { LobeChatDatabase } from '@lobechat/database';
import { getTestDB } from '@lobechat/database/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cleanupAicoTables, seedUsers } from '@/database/models/__tests__/aico.phase2.helpers';
import { AicoBillingModel } from '@/database/models/aicoBilling';
import { userWallets } from '@/database/schemas/aicoOrganization';
import type * as AicoEnvModule from '@/envs/aico';

import type { LedgerGate } from './ledger/gate';
import { AicoManagedPolicy } from './managedPolicy';

vi.mock('@/envs/aico', async (importOriginal) => {
  const actual = await importOriginal<typeof AicoEnvModule>();
  return { ...actual, aicoEnv: { ...actual.aicoEnv, AICO_ALLOW_TRIAL: true } };
});

const gate: LedgerGate = { authoritative: true, mode: 'enforce', sharedKey: 'sk-shared-test' };
const userId = 'trial-policy-user';
const phone = '+989125556677';
const personal = { billing: { source: 'personal' }, modelId: OPENROUTER_AUTO_MODEL_ID, userId };

let db: LobeChatDatabase;
let billing: AicoBillingModel;

const requestCount = async () => (await billing.getUserTrial(userId))?.requestCount;
const policy = () => new AicoManagedPolicy(db, async () => 'decrypted', undefined, gate);

beforeEach(async () => {
  db = await getTestDB();
  billing = new AicoBillingModel(db);
  await cleanupAicoTables(db);
  await seedUsers(db, [
    { email: 'trial-policy@example.com', id: userId, phone, phoneNumberVerified: true },
  ]);
  await billing.updateTrialConfig({
    allowedModelIds: [],
    durationDays: 3,
    enabled: true,
    maxRequests: 2,
    updatedByUserId: userId,
  });
  // An empty wallet: the trial is what lets these calls through.
  await db.insert(userWallets).values({ isActive: true, userId });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await cleanupAicoTables(db);
});

describe('AicoManagedPolicy trial request reservation', () => {
  it('reserves a unit per call and refuses with TRIAL_REQUEST_LIMIT at the cap', async () => {
    await billing.activateTrial({ phone, userId });

    await expect(policy().authorize(personal)).resolves.toMatchObject({
      trialRequestReserved: true,
    });
    await expect(policy().authorize(personal)).resolves.toMatchObject({
      trialRequestReserved: true,
    });
    await expect(policy().authorize(personal)).rejects.toMatchObject({
      code: 'TRIAL_REQUEST_LIMIT',
    });

    expect(await requestCount()).toBe(2);
  });

  it('lets only the remaining units through when calls race for them', async () => {
    await billing.activateTrial({ phone, userId });

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => policy().authorize(personal)),
    );

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    expect(
      results.filter((r) => r.status === 'rejected').map((r) => (r as any).reason.code),
    ).toEqual(['TRIAL_REQUEST_LIMIT', 'TRIAL_REQUEST_LIMIT', 'TRIAL_REQUEST_LIMIT']);
    expect(await requestCount()).toBe(2);
  });

  it('spends nothing when an earlier check refuses the call', async () => {
    await billing.activateTrial({ phone, userId });
    await db.update(userWallets).set({ isActive: false });

    await expect(policy().authorize(personal)).rejects.toMatchObject({
      code: 'PERSONAL_WALLET_INACTIVE',
    });
    expect(await requestCount()).toBe(0);
  });

  it('still refuses every Trial call in production', async () => {
    await billing.activateTrial({ phone, userId });
    vi.stubEnv('NODE_ENV', 'production');

    await expect(policy().authorize(personal)).rejects.toMatchObject({
      code: 'TRIAL_DISABLED_IN_PRODUCTION',
    });
    expect(await requestCount()).toBe(0);
  });

  it('reserves nothing for a user without a trial', async () => {
    await db
      .update(userWallets)
      .set({ balanceMicroUsd: 5_000_000, rawCapacityMicroUsd: 5_000_000 });

    const authorized = await policy().authorize(personal);

    expect(authorized.trialRequestReserved).toBeUndefined();
  });
});
