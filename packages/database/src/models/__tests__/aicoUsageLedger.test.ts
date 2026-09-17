/**
 * Usage ledger model — hold placement, settlement, expiry and budget epochs.
 */
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import {
  memberBudgets,
  organizationMembers,
  organizations,
  usageHolds,
  usageLogs,
  userWallets,
} from '../../schemas/aicoOrganization';
import type { LobeChatDatabase } from '../../type';
import { applyMultiplierMicroUsd, billedUsageFromCapacity } from '../../utils/aicoMoney';
import { AicoUsageLedgerModel, type HoldSubject, type PlaceHoldParams } from '../aicoUsageLedger';
import { cleanupAicoTables, seedUsers } from './aico.phase2.helpers';

const serverDB: LobeChatDatabase = await getTestDB();
const ledger = new AicoUsageLedgerModel(serverDB);

const userId = 'ledger-user';
const ownerId = 'ledger-owner';
const walletSubject: HoldSubject = { type: 'wallet', userId };

const holdParams = (overrides: Partial<PlaceHoldParams> = {}): PlaceHoldParams => ({
  billingSource: 'personal',
  estInputTokens: 1000,
  holdRawMicroUsd: 300_000,
  maxOpenHolds: 6,
  maxOutputTokens: 32_000,
  modelId: 'glm-5.3-flash',
  modelMultiplierBp: 10_000,
  multiplierBp: 12_000,
  operation: 'chat',
  pricedModelId: 'glm-5.3-flash',
  subject: walletSubject,
  ttlSeconds: 900,
  ...overrides,
});

const seedWallet = async (values: Partial<typeof userWallets.$inferInsert> = {}) => {
  await serverDB.insert(userWallets).values({
    balanceMicroUsd: 1_200_000,
    rawCapacityMicroUsd: 1_000_000,
    userId,
    ...values,
  });
};

const getWallet = async () =>
  (await serverDB.query.userWallets.findFirst({ where: eq(userWallets.userId, userId) }))!;

const seedBudget = async (values: Partial<typeof memberBudgets.$inferInsert> = {}) => {
  const [org] = await serverDB
    .insert(organizations)
    .values({ name: 'Ledger Org', ownerUserId: ownerId, slug: 'ledger-org' })
    .returning();
  const [member] = await serverDB
    .insert(organizationMembers)
    .values({ orgId: org.id, role: 'member', status: 'active', userId })
    .returning();
  const [budget] = await serverDB
    .insert(memberBudgets)
    .values({
      orgId: org.id,
      orgMemberId: member.id,
      periodAmountMicroUsd: 1_000_000,
      ...values,
    })
    .returning();
  const subject: HoldSubject = {
    budgetId: budget.id,
    orgId: org.id,
    orgMemberId: member.id,
    type: 'budget',
    userId,
  };
  return { budget, subject };
};

const getBudget = async (id: string) =>
  (await serverDB.query.memberBudgets.findFirst({ where: eq(memberBudgets.id, id) }))!;

const getHold = async (id: string) =>
  (await serverDB.query.usageHolds.findFirst({ where: eq(usageHolds.id, id) }))!;

const placeOk = async (overrides: Partial<PlaceHoldParams> = {}) => {
  const result = await ledger.placeHold(holdParams(overrides));
  if (!result.ok) throw new Error(`expected hold, got ${JSON.stringify(result.refusal)}`);
  return result.holdId;
};

const expireHoldNow = (id: string) =>
  serverDB
    .update(usageHolds)
    .set({ expiresAt: sql`now() - interval '1 minute'` })
    .where(eq(usageHolds.id, id));

beforeEach(async () => {
  await cleanupAicoTables(serverDB);
  await seedUsers(serverDB, [
    { email: 'ledger-user@example.com', id: userId },
    { email: 'ledger-owner@example.com', id: ownerId },
  ]);
});

afterEach(async () => {
  await cleanupAicoTables(serverDB);
});

describe('AicoUsageLedgerModel.placeHold', () => {
  it('reserves a wallet hold in raw units', async () => {
    await seedWallet();
    const holdId = await placeOk();

    const wallet = await getWallet();
    expect(wallet).toMatchObject({ openHolds: 1, rawHeldMicroUsd: 300_000, rawUsedMicroUsd: 0 });
    expect(await getHold(holdId)).toMatchObject({
      holdMicroUsd: applyMultiplierMicroUsd(300_000, 12_000),
      holdRawMicroUsd: 300_000,
      mode: 'enforce',
      status: 'open',
      subjectType: 'wallet',
      unit: 'raw',
    });
  });

  it('refuses a wallet hold that does not fit and reports what is available', async () => {
    await seedWallet({ rawUsedMicroUsd: 800_000 });
    const result = await ledger.placeHold(holdParams());
    expect(result).toEqual({ ok: false, refusal: { available: 200_000, reason: 'funds' } });
    expect((await getWallet()).rawHeldMicroUsd).toBe(0);
    expect(await serverDB.select().from(usageHolds)).toHaveLength(0);
  });

  it('classifies inactive and missing wallets', async () => {
    expect(await ledger.placeHold(holdParams())).toEqual({
      ok: false,
      refusal: { reason: 'not_found' },
    });
    await seedWallet({ isActive: false });
    expect(await ledger.placeHold(holdParams())).toEqual({
      ok: false,
      refusal: { reason: 'inactive' },
    });
  });

  it('refuses once the open hold limit is reached', async () => {
    await seedWallet({ openHolds: 6 });
    expect(await ledger.placeHold(holdParams({ holdRawMicroUsd: 1 }))).toEqual({
      ok: false,
      refusal: { reason: 'concurrency' },
    });
  });

  it('refuses a budget whose renewal is in progress', async () => {
    const { subject } = await seedBudget({ renewalStatus: 'renewal_pending' });
    expect(await ledger.placeHold(holdParams({ billingSource: 'organization', subject }))).toEqual({
      ok: false,
      refusal: { reason: 'renewal_blocked' },
    });
  });

  it('gates a budget in billed units, using reserved when there is no period amount', async () => {
    const { budget, subject } = await seedBudget({
      periodAmountMicroUsd: 0,
      reservedMicroUsd: 500_000,
    });

    // 400,000 raw × 1.2 = 480,000 billed fits in 500,000.
    const holdId = await placeOk({
      billingSource: 'organization',
      holdRawMicroUsd: 400_000,
      subject,
    });
    expect(await getBudget(budget.id)).toMatchObject({ heldMicroUsd: 480_000, openHolds: 1 });
    expect(await getHold(holdId)).toMatchObject({ budgetEpoch: 0, unit: 'billed' });

    // 20,000 billed left; 20,000 raw would be 24,000 billed.
    expect(
      await ledger.placeHold(
        holdParams({ billingSource: 'organization', holdRawMicroUsd: 20_000, subject }),
      ),
    ).toEqual({ ok: false, refusal: { available: 20_000, reason: 'funds' } });
  });

  it('settles the subject’s own expired holds before placing a new one', async () => {
    await seedWallet();
    const stale = await placeOk({ holdRawMicroUsd: 600_000 });
    await expireHoldNow(stale);

    // Without the self-heal the stale hold would still occupy the only slot.
    const fresh = await placeOk({ holdRawMicroUsd: 100_000, maxOpenHolds: 1 });

    expect(await getHold(stale)).toMatchObject({
      chargedRawMicroUsd: 600_000,
      settleReason: 'expired',
      status: 'expired',
    });
    expect(await getHold(fresh)).toMatchObject({ status: 'open' });
    expect(await getWallet()).toMatchObject({
      openHolds: 1,
      rawHeldMicroUsd: 100_000,
      rawUsedMicroUsd: 600_000,
    });
  });
});

describe('AicoUsageLedgerModel.settleHold', () => {
  it('moves the actual charge into used and logs it once', async () => {
    await seedWallet();
    const holdId = await placeOk();

    const result = await ledger.settleHold(holdId, {
      chargedRawMicroUsd: 120_000,
      rawCostMicroUsd: 120_000,
      reason: 'usage',
      tokens: { completion: 500, prompt: 1000, reasoning: 0, total: 1500 },
    });
    expect(result).toEqual({ settled: true });

    const wallet = await getWallet();
    expect(wallet).toMatchObject({
      lastSyncStatus: 'synced',
      openHolds: 0,
      rawHeldMicroUsd: 0,
      rawUsedMicroUsd: 120_000,
    });
    expect(wallet.settledUsageMicroUsd).toBe(
      billedUsageFromCapacity({
        balanceMicroUsd: 1_200_000,
        fallbackBp: 12_000,
        rawCapacityMicroUsd: 1_000_000,
        rawUsageMicroUsd: 120_000,
      }),
    );

    const logs = await serverDB.select().from(usageLogs);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      completionTokens: 500,
      costMicroUsd: applyMultiplierMicroUsd(120_000, 12_000),
      holdId,
      promptTokens: 1000,
      settlementStatus: 'synchronized',
      totalTokens: 1500,
    });
    expect(await getHold(holdId)).toMatchObject({
      chargedRawMicroUsd: 120_000,
      promptTokens: 1000,
      settleReason: 'usage',
      status: 'settled',
    });
  });

  it('is idempotent', async () => {
    await seedWallet();
    const holdId = await placeOk();
    await ledger.settleHold(holdId, { chargedRawMicroUsd: 120_000, reason: 'usage' });

    const second = await ledger.settleHold(holdId, {
      chargedRawMicroUsd: 999_999,
      reason: 'usage',
    });
    expect(second).toEqual({ settled: false });
    expect(await getWallet()).toMatchObject({ openHolds: 0, rawUsedMicroUsd: 120_000 });
    expect(await serverDB.select().from(usageLogs)).toHaveLength(1);
  });

  it('charges nothing for an upstream rejection and the hold for an unmeasured call', async () => {
    await seedWallet();
    const rejected = await placeOk({ holdRawMicroUsd: 100_000 });
    const unmeasured = await placeOk({ holdRawMicroUsd: 200_000 });

    await ledger.settleHold(rejected, { reason: 'released_rejected' });
    await ledger.settleHold(unmeasured, { reason: 'estimate_no_usage' });

    expect(await getWallet()).toMatchObject({
      openHolds: 0,
      rawHeldMicroUsd: 0,
      rawUsedMicroUsd: 200_000,
    });
    const statuses = (await serverDB.select().from(usageLogs))
      .map((l) => [l.holdId, l.settlementStatus, l.costMicroUsd])
      .sort();
    expect(statuses).toEqual(
      [
        [rejected, 'released', 0],
        [unmeasured, 'estimated', applyMultiplierMicroUsd(200_000, 12_000)],
      ].sort(),
    );
  });

  it('expireHolds charges the full hold and a later settle is a no-op', async () => {
    await seedWallet();
    const holdId = await placeOk();
    const notDue = await placeOk({ holdRawMicroUsd: 1000 });
    await expireHoldNow(holdId);

    expect(await ledger.expireHolds({ limit: 10 })).toBe(1);
    expect(await getHold(holdId)).toMatchObject({ chargedRawMicroUsd: 300_000, status: 'expired' });
    expect(await getHold(notDue)).toMatchObject({ status: 'open' });

    expect(await ledger.settleHold(holdId, { chargedRawMicroUsd: 1, reason: 'usage' })).toEqual({
      settled: false,
    });
    expect(await getWallet()).toMatchObject({
      openHolds: 1,
      rawHeldMicroUsd: 1000,
      rawUsedMicroUsd: 300_000,
    });
  });

  it('does not charge a renewed cycle for a hold placed before the renewal', async () => {
    const { budget, subject } = await seedBudget();
    const oldCycle = await placeOk({ billingSource: 'organization', subject });
    const sameCycle = await placeOk({ billingSource: 'organization', subject });

    await serverDB
      .update(memberBudgets)
      .set({ ledgerEpoch: 1 })
      .where(eq(memberBudgets.id, budget.id));
    await ledger.settleHold(oldCycle, { chargedRawMicroUsd: 100_000, reason: 'usage' });

    let row = await getBudget(budget.id);
    expect(row).toMatchObject({
      heldMicroUsd: applyMultiplierMicroUsd(300_000, 12_000),
      openHolds: 1,
      settledUsageMicroUsd: 0,
    });

    // A hold from the current epoch does add its charge.
    await serverDB.update(usageHolds).set({ budgetEpoch: 1 }).where(eq(usageHolds.id, sameCycle));
    await ledger.settleHold(sameCycle, { chargedRawMicroUsd: 100_000, reason: 'usage' });

    row = await getBudget(budget.id);
    expect(row).toMatchObject({
      heldMicroUsd: 0,
      openHolds: 0,
      settledUsageMicroUsd: applyMultiplierMicroUsd(100_000, 12_000),
    });
  });

  it('settles a shadow hold without touching the subject or usage_logs', async () => {
    await seedWallet();
    const holdId = await ledger.recordShadowHold({
      ...holdParams(),
      refuseReason: null,
      wouldRefuse: false,
    });

    expect(
      await ledger.settleHold(holdId, { chargedRawMicroUsd: 50_000, reason: 'usage' }),
    ).toEqual({ settled: true });
    expect(await getHold(holdId)).toMatchObject({
      chargedRawMicroUsd: 50_000,
      mode: 'shadow',
      status: 'settled',
    });
    expect(await getWallet()).toMatchObject({
      openHolds: 0,
      rawHeldMicroUsd: 0,
      rawUsedMicroUsd: 0,
      settledUsageMicroUsd: 0,
    });
    expect(await serverDB.select().from(usageLogs)).toHaveLength(0);
  });
});

describe('AicoUsageLedgerModel aggregates and state', () => {
  it('aggregates open enforce holds and charges inside a window', async () => {
    await seedWallet();
    await placeOk({ holdRawMicroUsd: 100_000 });
    const settled = await placeOk({ holdRawMicroUsd: 200_000 });
    await ledger.recordShadowHold({ ...holdParams(), refuseReason: null, wouldRefuse: false });

    expect(await ledger.aggregateOpenHoldsRaw()).toBe(300_000);
    expect(await ledger.countOpenEnforceHolds()).toBe(2);

    const before = new Date(Date.now() - 60_000);
    await ledger.settleHold(settled, { chargedRawMicroUsd: 150_000, reason: 'usage' });
    const after = new Date(Date.now() + 60_000);

    expect(await ledger.aggregateOpenHoldsRaw()).toBe(100_000);
    expect(await ledger.sumChargedRaw({ from: before, to: after })).toBe(150_000);
    expect(await ledger.sumChargedRaw({ from: after, to: new Date(Date.now() + 120_000) })).toBe(0);
  });

  it('claimFloatRefresh grants one claim per window', async () => {
    expect(await ledger.claimFloatRefresh()).toBe(true);
    expect(await ledger.claimFloatRefresh()).toBe(false);
  });

  it('updateState patches the default row', async () => {
    await ledger.updateState({ paused: true });
    expect(await ledger.getState()).toMatchObject({ id: 'default', paused: true });
  });

  it('shadowAvailability reports funds from the legacy settled figure', async () => {
    await seedWallet({ balanceMicroUsd: 1_000_000, settledUsageMicroUsd: 900_000 });
    expect(
      await ledger.shadowAvailability({
        holdBilledMicroUsd: 200_000,
        maxOpenHolds: 6,
        subject: walletSubject,
      }),
    ).toEqual({ available: 100_000, reason: 'funds' });
    expect(
      await ledger.shadowAvailability({
        holdBilledMicroUsd: 50_000,
        maxOpenHolds: 6,
        subject: walletSubject,
      }),
    ).toBeNull();
  });
});
