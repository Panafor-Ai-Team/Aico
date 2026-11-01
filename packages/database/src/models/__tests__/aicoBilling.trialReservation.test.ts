/**
 * AICO-P1-010: a Trial request is reserved atomically against the platform cap, so
 * concurrent requests can never spend more than `maxRequests`, and a reservation can be
 * given back when the provider call never started.
 */
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import { userTrials } from '../../schemas/aicoOrganization';
import type { LobeChatDatabase } from '../../type';
import { AicoBillingModel } from '../aicoBilling';
import { cleanupAicoTables, seedUsers } from './aico.phase2.helpers';

const serverDB: LobeChatDatabase = await getTestDB();
const billing = new AicoBillingModel(serverDB);
const userId = 'trial-reserve-u1';

const setCap = (maxRequests: number | null) =>
  billing.updateTrialConfig({
    allowedModelIds: ['openai/gpt-4o-mini'],
    durationDays: 3,
    enabled: true,
    maxRequests,
    updatedByUserId: userId,
  });

const countOf = async () => (await billing.getUserTrial(userId))?.requestCount;

beforeEach(async () => {
  await cleanupAicoTables(serverDB);
  await seedUsers(serverDB, [
    { email: 'reserve@example.com', id: userId, phone: '+989123334455', phoneNumberVerified: true },
  ]);
  await setCap(2);
  await billing.activateTrial({ phone: '+989123334455', userId });
});

afterEach(async () => {
  await cleanupAicoTables(serverDB);
});

describe('AicoBillingModel trial request reservation', () => {
  it('lets exactly `maxRequests` of many concurrent reservations through', async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, () => billing.incrementTrialRequest(userId)),
    );

    expect(results.filter(Boolean)).toHaveLength(2);
    expect(await countOf()).toBe(2);
  });

  it('refuses once the cap is reached, without changing the count', async () => {
    expect(await billing.incrementTrialRequest(userId)).toBeTruthy();
    expect(await billing.incrementTrialRequest(userId)).toBeTruthy();

    expect(await billing.incrementTrialRequest(userId)).toBeUndefined();
    expect(await countOf()).toBe(2);
  });

  it('follows the cap the platform admin sets, and treats no cap as unlimited', async () => {
    await setCap(null);
    for (let i = 0; i < 5; i += 1) expect(await billing.incrementTrialRequest(userId)).toBeTruthy();
    expect(await countOf()).toBe(5);

    await setCap(5);
    expect(await billing.incrementTrialRequest(userId)).toBeUndefined();
  });

  it('never reserves on an expired trial', async () => {
    await serverDB
      .update(userTrials)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(userTrials.userId, userId));

    expect(await billing.incrementTrialRequest(userId)).toBeUndefined();
    expect(await countOf()).toBe(0);
  });

  it('gives a reservation back, never below zero', async () => {
    await billing.incrementTrialRequest(userId);
    await billing.releaseTrialRequest(userId);
    expect(await countOf()).toBe(0);

    await billing.releaseTrialRequest(userId);
    expect(await countOf()).toBe(0);
  });
});
