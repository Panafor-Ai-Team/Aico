/**
 * N10 — what the usage reports count from `usage_logs`.
 *
 * Under the shadow ledger a call settled without a measured figure is logged at
 * the full hold, an upper bound nothing was debited for. Reports must show the
 * measured spend, and keep the estimate separate. Enforce rows are real charges
 * either way and are always counted.
 */
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import {
  memberBudgets,
  organizationMembers,
  organizations,
  userWallets,
} from '../../schemas/aicoOrganization';
import type { LobeChatDatabase } from '../../type';
import { applyMultiplierMicroUsd } from '../../utils/aicoMoney';
import { AicoBillingModel } from '../aicoBilling';
import { AicoUsageLedgerModel, type HoldSubject, type PlaceHoldParams } from '../aicoUsageLedger';
import { OrganizationModel } from '../organization';
import { cleanupAicoTables, seedUsers } from './aico.phase2.helpers';

const serverDB: LobeChatDatabase = await getTestDB();
const ledger = new AicoUsageLedgerModel(serverDB);
const billing = new AicoBillingModel(serverDB);
const orgModel = new OrganizationModel(serverDB);

const userId = 'reports-user';
const ownerId = 'reports-owner';
const HOLD_RAW = 300_000;
const HOLD_BILLED = applyMultiplierMicroUsd(HOLD_RAW, 12_000);
const USED_RAW = 50_000;
const USED_BILLED = applyMultiplierMicroUsd(USED_RAW, 12_000);

const params = (
  subject: HoldSubject,
  overrides: Partial<PlaceHoldParams> = {},
): PlaceHoldParams => ({
  billingSource: subject.type === 'wallet' ? 'personal' : 'organization',
  estInputTokens: 1000,
  holdRawMicroUsd: HOLD_RAW,
  maxOpenHolds: 6,
  maxOutputTokens: 32_000,
  modelId: 'glm-5.3-flash',
  modelMultiplierBp: 10_000,
  multiplierBp: 12_000,
  operation: 'chat',
  pricedModelId: 'glm-5.3-flash',
  subject,
  ttlSeconds: 900,
  ...overrides,
});

/** A shadow call settled with the given reason. */
const shadowCall = async (
  subject: HoldSubject,
  reason: 'estimate_aborted' | 'estimate_error' | 'usage',
) => {
  const holdId = await ledger.recordShadowHold({
    ...params(subject),
    refuseReason: null,
    wouldRefuse: false,
  });
  await ledger.settleHold(holdId, {
    ...(reason === 'usage' ? { chargedRawMicroUsd: USED_RAW } : {}),
    reason,
    tokens: { completion: 10, prompt: 20, reasoning: 0, total: 30 },
  });
};

beforeEach(async () => {
  await cleanupAicoTables(serverDB);
  await seedUsers(serverDB, [
    { email: 'reports-user@example.com', id: userId },
    { email: 'reports-owner@example.com', id: ownerId },
  ]);
});

afterEach(async () => {
  await cleanupAicoTables(serverDB);
});

const today = () => new Date().toISOString().slice(0, 10);

describe('N10: measured spend versus estimated upper bound', () => {
  const seedWalletCalls = async () => {
    await serverDB
      .insert(userWallets)
      .values({ balanceMicroUsd: 9_000_000, rawCapacityMicroUsd: 8_000_000, userId });
    const subject: HoldSubject = { type: 'wallet', userId };
    await shadowCall(subject, 'usage');
    await shadowCall(subject, 'estimate_error');
    await shadowCall(subject, 'estimate_aborted');
    return subject;
  };

  it('the platform total counts measured shadow spend only', async () => {
    await seedWalletCalls();

    expect(await billing.sumUsageCostMicroUsd()).toBe(USED_BILLED);
    expect(await billing.sumUnmeasuredUsageCostMicroUsd()).toBe(HOLD_BILLED * 2);
  });

  it('a user sees what they were metered, and which calls were only estimated', async () => {
    await seedWalletCalls();

    const rows = await billing.listUserUsage(userId);

    expect(rows).toHaveLength(3);
    expect(rows.filter((row) => row.costMeasured)).toHaveLength(1);
    expect(rows.find((row) => row.costMeasured)?.costMicroUsd).toBe(USED_BILLED);
    expect(rows.filter((row) => !row.costMeasured).map((row) => row.settlementStatus)).toEqual([
      'shadow',
      'shadow',
    ]);
  });

  it('enforce rows are real charges and are always counted, estimated or not', async () => {
    await serverDB
      .insert(userWallets)
      .values({ balanceMicroUsd: 9_000_000, rawCapacityMicroUsd: 8_000_000, userId });
    const placed = await ledger.placeHold(params({ type: 'wallet', userId }));
    if (!placed.ok) throw new Error('expected an enforce hold');
    await ledger.settleHold(placed.holdId, { reason: 'estimate_error' });

    expect(await billing.sumUsageCostMicroUsd()).toBe(HOLD_BILLED);
    expect(await billing.sumUnmeasuredUsageCostMicroUsd()).toBe(0);
    expect((await billing.listUserUsage(userId))[0].costMeasured).toBe(true);
  });

  it('the org chart shows measured spend per day, not the hold', async () => {
    const org = await orgModel.createOrganization({ name: 'Reports Org', ownerUserId: ownerId });
    const member = (await orgModel.listMembers(org.id)).find((m) => m.userId === ownerId)!;
    const [budget] = await serverDB
      .insert(memberBudgets)
      .values({ orgId: org.id, orgMemberId: member.id, periodAmountMicroUsd: 9_000_000 })
      .returning();
    const subject: HoldSubject = {
      budgetId: budget.id,
      orgId: org.id,
      orgMemberId: member.id,
      type: 'budget',
      userId: ownerId,
    };
    await shadowCall(subject, 'usage');
    await shadowCall(subject, 'estimate_error');

    const points = await orgModel.getOrgUsageChart({ from: today(), orgId: org.id, to: today() });

    expect(points).toHaveLength(1);
    expect(points[0].costMicroUsd).toBe(USED_BILLED);
    // Tokens still count: the calls happened.
    expect(points[0].totalTokens).toBe(60);
    // Silence unused imports kept for the schema cleanup order.
    void [organizations, organizationMembers, eq];
  });
});
