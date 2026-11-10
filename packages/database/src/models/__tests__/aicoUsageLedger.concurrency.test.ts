/**
 * Usage ledger under real concurrency. PGlite serialises everything, so these
 * only mean something against a server database (`TEST_SERVER_DB=1`).
 */
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import {
  memberBudgets,
  organizationMembers,
  organizations,
  usageLogs,
  userWallets,
} from '../../schemas/aicoOrganization';
import type { LobeChatDatabase } from '../../type';
import { AicoUsageLedgerModel, type HoldSubject, type PlaceHoldParams } from '../aicoUsageLedger';
import { cleanupAicoTables, isServerDb, seedUsers } from './aico.phase2.helpers';

const serverDB: LobeChatDatabase = await getTestDB();
const ledger = new AicoUsageLedgerModel(serverDB);

const userId = 'ledger-conc-user';
const ownerId = 'ledger-conc-owner';

const holdParams = (subject: HoldSubject, overrides: Partial<PlaceHoldParams> = {}) =>
  ({
    billingSource: subject.type === 'wallet' ? 'personal' : 'organization',
    estInputTokens: 0,
    holdRawMicroUsd: 300_000,
    maxOpenHolds: 64,
    maxOutputTokens: 0,
    modelId: 'glm-5.3-flash',
    modelMultiplierBp: 10_000,
    multiplierBp: 10_000,
    operation: 'chat',
    pricedModelId: 'glm-5.3-flash',
    subject,
    ttlSeconds: 900,
    ...overrides,
  }) satisfies PlaceHoldParams;

const placeParallel = async (count: number, params: PlaceHoldParams) =>
  Promise.all(Array.from({ length: count }, () => ledger.placeHold(params)));

beforeEach(async () => {
  await cleanupAicoTables(serverDB);
  await seedUsers(serverDB, [
    { email: 'ledger-conc-user@example.com', id: userId },
    { email: 'ledger-conc-owner@example.com', id: ownerId },
  ]);
});

afterEach(async () => {
  await cleanupAicoTables(serverDB);
});

describe('AicoUsageLedgerModel concurrency', () => {
  it.skipIf(!isServerDb())('never over-reserves a wallet under parallel holds', async () => {
    await serverDB
      .insert(userWallets)
      .values({ balanceMicroUsd: 1_000_000, rawCapacityMicroUsd: 1_000_000, userId });

    const results = await placeParallel(20, holdParams({ type: 'wallet', userId }));

    expect(results.filter((r) => r.ok)).toHaveLength(3);
    const wallet = await serverDB.query.userWallets.findFirst({
      where: eq(userWallets.userId, userId),
    });
    expect(wallet).toMatchObject({ openHolds: 3, rawHeldMicroUsd: 900_000 });
  });

  it.skipIf(!isServerDb())('never exceeds the open hold limit', async () => {
    await serverDB
      .insert(userWallets)
      .values({ balanceMicroUsd: 1_000_000, rawCapacityMicroUsd: 1_000_000, userId });

    const results = await placeParallel(
      20,
      holdParams({ type: 'wallet', userId }, { holdRawMicroUsd: 1, maxOpenHolds: 6 }),
    );

    expect(results.filter((r) => r.ok)).toHaveLength(6);
  });

  it.skipIf(!isServerDb())('settles a hold exactly once under parallel settles', async () => {
    await serverDB
      .insert(userWallets)
      .values({ balanceMicroUsd: 1_000_000, rawCapacityMicroUsd: 1_000_000, userId });
    const placed = await ledger.placeHold(holdParams({ type: 'wallet', userId }));
    if (!placed.ok) throw new Error('hold refused');

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        ledger.settleHold(placed.holdId, { chargedRawMicroUsd: 100_000, reason: 'usage' }),
      ),
    );

    expect(results.filter((r) => r.settled)).toHaveLength(1);
    expect(await serverDB.select().from(usageLogs)).toHaveLength(1);
    const wallet = await serverDB.query.userWallets.findFirst({
      where: eq(userWallets.userId, userId),
    });
    expect(wallet).toMatchObject({ openHolds: 0, rawHeldMicroUsd: 0, rawUsedMicroUsd: 100_000 });
  });

  it.skipIf(!isServerDb())('never over-reserves a budget under parallel holds', async () => {
    const [org] = await serverDB
      .insert(organizations)
      .values({ name: 'Conc Org', ownerUserId: ownerId, slug: 'ledger-conc-org' })
      .returning();
    const [member] = await serverDB
      .insert(organizationMembers)
      .values({ orgId: org.id, role: 'member', status: 'active', userId })
      .returning();
    const [budget] = await serverDB
      .insert(memberBudgets)
      .values({ orgId: org.id, orgMemberId: member.id, periodAmountMicroUsd: 1_000_000 })
      .returning();

    const results = await placeParallel(
      20,
      holdParams({
        budgetId: budget.id,
        orgId: org.id,
        orgMemberId: member.id,
        type: 'budget',
        userId,
      }),
    );

    expect(results.filter((r) => r.ok)).toHaveLength(3);
    const row = await serverDB.query.memberBudgets.findFirst({
      where: eq(memberBudgets.id, budget.id),
    });
    expect(row).toMatchObject({ heldMicroUsd: 900_000, openHolds: 3 });
  });
});
