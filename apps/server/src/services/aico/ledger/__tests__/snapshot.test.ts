// @vitest-environment node
import type { LobeChatDatabase } from '@lobechat/database';
import { getTestDB } from '@lobechat/database/test-utils';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { cleanupAicoTables, seedUsers } from '@/database/models/__tests__/aico.phase2.helpers';
import { AicoUsageLedgerModel } from '@/database/models/aicoUsageLedger';
import { OrganizationModel } from '@/database/models/organization';
import { memberBudgets, usageHolds, userWallets } from '@/database/schemas/aicoOrganization';

import { runLedgerSnapshotPhase } from '../snapshot';
import { resetLedgerStateCacheForTests } from '../state';

const h = vi.hoisted(() => ({ mode: 'enforce' }));

vi.mock('@/server/services/aico/ledger/config', () => ({
  getLedgerConfig: () => ({ mode: h.mode }),
  isSharedInferenceKey: () => false,
}));

const userIds = ['snap-a', 'snap-b', 'snap-c'];
let db: LobeChatDatabase;
let ledger: AicoUsageLedgerModel;

const keyService = () => ({
  readWalletRawUsage: vi.fn(async (userId: string) => ({
    degraded: userId === 'snap-b',
    rawUsedMicroUsd: 100_000,
  })),
  syncMemberCycleUsage: vi.fn(async () => null),
});

beforeEach(async () => {
  h.mode = 'enforce';
  resetLedgerStateCacheForTests();
  db = await getTestDB();
  await cleanupAicoTables(db);
  await seedUsers(
    db,
    userIds.map((id) => ({ email: `${id}@example.com`, id })),
  );
  await db.insert(userWallets).values(
    userIds.map((userId, i) => ({
      balanceMicroUsd: 1_000_000,
      id: `wal-${i}`,
      rawCapacityMicroUsd: 800_000,
      rawHeldMicroUsd: 5,
      userId,
    })),
  );
  ledger = new AicoUsageLedgerModel(db);
  await ledger.updateState({ paused: true });
});

const wallet = async (userId: string) =>
  (await db.select().from(userWallets).where(eq(userWallets.userId, userId)))[0];

describe('runLedgerSnapshotPhase preconditions', () => {
  it('refuses outside enforce', async () => {
    h.mode = 'shadow';
    await expect(runLedgerSnapshotPhase(db, { phase: 'wallets' })).resolves.toEqual({
      body: { reason: 'mode_not_enforce' },
      status: 409,
    });
  });

  it('refuses while traffic is live', async () => {
    await ledger.updateState({ paused: false });
    await expect(runLedgerSnapshotPhase(db, { phase: 'wallets' })).resolves.toMatchObject({
      body: { reason: 'not_paused' },
      status: 409,
    });
  });

  it('refuses after the cutover finished', async () => {
    await ledger.updateState({ snapshotCompletedAt: new Date() });
    await expect(runLedgerSnapshotPhase(db, { phase: 'budgets' })).resolves.toMatchObject({
      body: { reason: 'already_completed' },
      status: 409,
    });
  });

  it('refuses while an enforce hold is open', async () => {
    await db.insert(usageHolds).values({
      billingSource: 'personal',
      expiresAt: new Date(Date.now() + 60_000),
      mode: 'enforce',
      modelId: 'm',
      multiplierBp: 10_000,
      operation: 'chat',
      subjectType: 'wallet',
      unit: 'raw',
      userId: 'snap-a',
    });
    await expect(runLedgerSnapshotPhase(db, { phase: 'wallets' })).resolves.toMatchObject({
      body: { reason: 'open_holds' },
      status: 409,
    });
  });
});

describe('wallets phase', () => {
  it('pages through a cursor, writes raw usage and marks degraded wallets', async () => {
    const keys = keyService();

    const first = await runLedgerSnapshotPhase(db, {
      keyService: keys,
      limit: 2,
      phase: 'wallets',
    });
    expect(first).toEqual({
      body: { degradedUserIds: ['snap-b'], done: false, processed: 2 },
      status: 200,
    });
    const second = await runLedgerSnapshotPhase(db, {
      keyService: keys,
      limit: 2,
      phase: 'wallets',
    });
    expect(second.body).toMatchObject({ done: true, processed: 1 });
    expect(keys.readWalletRawUsage).toHaveBeenCalledTimes(3);

    const a = await wallet('snap-a');
    expect(a.rawUsedMicroUsd).toBe(100_000);
    expect(a.rawHeldMicroUsd).toBe(0);
    expect(a.lastSyncStatus).toBe('synced');
    expect(Number(a.settledUsageMicroUsd)).toBeGreaterThan(0);
    const b = await wallet('snap-b');
    expect(b.lastSyncStatus).toBe('degraded');
    expect(b.lastSyncError).toBe('LEDGER_SNAPSHOT_DEGRADED');
    expect((await ledger.getState()).snapshotWalletsDoneAt).toBeTruthy();
  });

  it('stops on a transient error with the cursor at the last success', async () => {
    const keys = keyService();
    keys.readWalletRawUsage.mockImplementation(async (userId: string) => {
      if (userId === 'snap-b') throw new Error('CheapVibeCode API 503');
      return { degraded: false, rawUsedMicroUsd: 1 };
    });

    await expect(
      runLedgerSnapshotPhase(db, { keyService: keys, limit: 10, phase: 'wallets' }),
    ).resolves.toEqual({
      body: { failedUserId: 'snap-b', message: 'CheapVibeCode API 503', processed: 1 },
      status: 502,
    });
    expect((await ledger.getState()).snapshotWalletsCursor).toBe('wal-0');
    expect((await wallet('snap-c')).rawUsedMicroUsd).toBe(0);
  });
});

describe('budgets phase and finalize', () => {
  const seedBudget = async (keyId: string | null) => {
    const orgModel = new OrganizationModel(db);
    const org = await orgModel.createOrganization({ name: 'Snap Org', ownerUserId: 'snap-a' });
    const me = (await orgModel.listMembers(org.id)).find((m) => m.userId === 'snap-a')!;
    await db.insert(memberBudgets).values({
      heldMicroUsd: 700,
      openHolds: 2,
      openrouterKeyId: keyId,
      orgId: org.id,
      orgMemberId: me.id,
      periodAmountMicroUsd: 1_000_000,
    });
    return me.id;
  };

  it('syncs keyed budgets and zeroes held on every budget', async () => {
    const orgMemberId = await seedBudget('cvc-key');
    const keys = keyService();

    const result = await runLedgerSnapshotPhase(db, { keyService: keys, phase: 'budgets' });
    expect(result.body).toEqual({ done: true, processed: 1 });
    expect(keys.syncMemberCycleUsage).toHaveBeenCalledWith(orgMemberId);

    const [budget] = await db
      .select()
      .from(memberBudgets)
      .where(eq(memberBudgets.orgMemberId, orgMemberId));
    expect(budget.heldMicroUsd).toBe(0);
    expect(budget.openHolds).toBe(0);
  });

  it('finalize needs both phases and keeps the first enforce start', async () => {
    const keys = keyService();
    await expect(runLedgerSnapshotPhase(db, { phase: 'finalize' })).resolves.toMatchObject({
      body: { reason: 'wallets_pending' },
      status: 409,
    });
    await runLedgerSnapshotPhase(db, { keyService: keys, phase: 'wallets' });
    await expect(runLedgerSnapshotPhase(db, { phase: 'finalize' })).resolves.toMatchObject({
      body: { reason: 'budgets_pending' },
      status: 409,
    });
    await runLedgerSnapshotPhase(db, { keyService: keys, phase: 'budgets' });

    const started = new Date('2026-01-01T00:00:00Z');
    await ledger.updateState({ enforceStartedAt: started });

    await expect(runLedgerSnapshotPhase(db, { phase: 'finalize' })).resolves.toEqual({
      body: { degradedWallets: 1, overdrawnWallets: 0, totalRawAvailable: 3 * 700_000 },
      status: 200,
    });
    const state = await ledger.getState();
    expect(state.snapshotCompletedAt).toBeTruthy();
    expect(new Date(state.enforceStartedAt!).toISOString()).toBe(started.toISOString());
  });
});
