import { asc, eq, gt, sql } from 'drizzle-orm';

import { AicoUsageLedgerModel, LEDGER_STATE_ID } from '@/database/models/aicoUsageLedger';
import { aicoLedgerState, memberBudgets, userWallets } from '@/database/schemas/aicoOrganization';
import type { LobeChatDatabase } from '@/database/type';
import { billedUsageFromCapacity, hasValidManagedKeyId } from '@/database/utils/aicoMoney';
import { AicoOpenRouterKeyService } from '@/server/services/openrouter/keyService';

import { getCachedUsageMultiplierBp } from '../usageMultiplier';
import { getLedgerConfig } from './config';
import { getLedgerState, invalidateLedgerStateCache } from './state';

export type SnapshotPhase = 'budgets' | 'finalize' | 'wallets';

export const SNAPSHOT_DEFAULT_LIMIT = 25;
export const SNAPSHOT_MAX_LIMIT = 100;

export const LEDGER_SNAPSHOT_DEGRADED = 'LEDGER_SNAPSHOT_DEGRADED';

export interface SnapshotResponse {
  body: Record<string, unknown>;
  status: 200 | 409 | 502;
}

type SnapshotKeyService = Pick<
  AicoOpenRouterKeyService,
  'readWalletRawUsage' | 'syncMemberCycleUsage'
>;

const conflict = (reason: string): SnapshotResponse => ({ body: { reason }, status: 409 });

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error ?? 'unknown error');

/**
 * Every phase runs only while enforce is configured, traffic is paused, no
 * enforce hold is open and the cutover has not been finalized. Otherwise the
 * readings could race live spend.
 */
const checkPreconditions = async (db: LobeChatDatabase): Promise<SnapshotResponse | null> => {
  if (getLedgerConfig().mode !== 'enforce') return conflict('mode_not_enforce');
  const state = await getLedgerState(db, { fresh: true });
  if (!state.paused) return conflict('not_paused');
  if (state.snapshotCompletedAt) return conflict('already_completed');
  if ((await new AicoUsageLedgerModel(db).countOpenEnforceHolds()) > 0) {
    return conflict('open_holds');
  }
  return null;
};

/** Copies each wallet's spend on its legacy key into `raw_used_micro_usd`. */
const snapshotWallets = async (
  db: LobeChatDatabase,
  params: { cursor: string | null; keyService: SnapshotKeyService; limit: number },
): Promise<SnapshotResponse> => {
  const ledger = new AicoUsageLedgerModel(db);
  const rows = await db
    .select({
      balanceMicroUsd: userWallets.balanceMicroUsd,
      id: userWallets.id,
      rawCapacityMicroUsd: userWallets.rawCapacityMicroUsd,
      userId: userWallets.userId,
    })
    .from(userWallets)
    .where(params.cursor ? gt(userWallets.id, params.cursor) : undefined)
    .orderBy(asc(userWallets.id))
    .limit(params.limit);

  const platformBp = await getCachedUsageMultiplierBp(db);
  const degradedUserIds: string[] = [];
  let processed = 0;

  for (const row of rows) {
    let reading: { degraded: boolean; rawUsedMicroUsd: number };
    try {
      reading = await params.keyService.readWalletRawUsage(row.userId);
    } catch (error) {
      // The cursor already points at the last wallet written; a rerun resumes here.
      return {
        body: { failedUserId: row.userId, message: errorMessage(error), processed },
        status: 502,
      };
    }

    const rawUsedMicroUsd = Math.max(0, Math.trunc(reading.rawUsedMicroUsd));
    await db
      .update(userWallets)
      .set({
        lastSyncError: reading.degraded ? LEDGER_SNAPSHOT_DEGRADED : null,
        lastSyncStatus: reading.degraded ? 'degraded' : 'synced',
        lastSyncedAt: new Date(),
        openHolds: 0,
        rawHeldMicroUsd: 0,
        rawUsedMicroUsd,
        settledUsageMicroUsd: billedUsageFromCapacity({
          balanceMicroUsd: Number(row.balanceMicroUsd ?? 0),
          fallbackBp: platformBp,
          rawCapacityMicroUsd: Number(row.rawCapacityMicroUsd ?? 0),
          rawUsageMicroUsd: rawUsedMicroUsd,
        }),
        updatedAt: new Date(),
      })
      .where(eq(userWallets.id, row.id));
    await ledger.updateState({ snapshotWalletsCursor: row.id });

    if (reading.degraded) degradedUserIds.push(row.userId);
    processed += 1;
  }

  const done = rows.length < params.limit;
  if (done) await ledger.updateState({ snapshotWalletsDoneAt: new Date() });
  invalidateLedgerStateCache();
  return { body: { degradedUserIds, done, processed }, status: 200 };
};

/** Brings each budget's settled usage current from its legacy key and clears held. */
const snapshotBudgets = async (
  db: LobeChatDatabase,
  params: { cursor: string | null; keyService: SnapshotKeyService; limit: number },
): Promise<SnapshotResponse> => {
  const ledger = new AicoUsageLedgerModel(db);
  const rows = await db
    .select({
      id: memberBudgets.id,
      openrouterKeyId: memberBudgets.openrouterKeyId,
      orgMemberId: memberBudgets.orgMemberId,
    })
    .from(memberBudgets)
    .where(params.cursor ? gt(memberBudgets.id, params.cursor) : undefined)
    .orderBy(asc(memberBudgets.id))
    .limit(params.limit);

  let processed = 0;

  for (const row of rows) {
    if (hasValidManagedKeyId(row.openrouterKeyId)) {
      try {
        // Not authoritative yet, so this is the legacy key read. It skips keys
        // from another provider on its own.
        await params.keyService.syncMemberCycleUsage(row.orgMemberId);
      } catch (error) {
        return {
          body: { failedOrgMemberId: row.orgMemberId, message: errorMessage(error), processed },
          status: 502,
        };
      }
    }

    await db
      .update(memberBudgets)
      .set({ heldMicroUsd: 0, openHolds: 0, updatedAt: new Date() })
      .where(eq(memberBudgets.id, row.id));
    await ledger.updateState({ snapshotBudgetsCursor: row.id });
    processed += 1;
  }

  const done = rows.length < params.limit;
  if (done) await ledger.updateState({ snapshotBudgetsDoneAt: new Date() });
  invalidateLedgerStateCache();
  return { body: { done, processed }, status: 200 };
};

const finalize = async (db: LobeChatDatabase): Promise<SnapshotResponse> => {
  const state = await getLedgerState(db, { fresh: true });
  if (!state.snapshotWalletsDoneAt) return conflict('wallets_pending');
  if (!state.snapshotBudgetsDoneAt) return conflict('budgets_pending');

  await db
    .update(aicoLedgerState)
    .set({
      // A second cutover after a deliberate reset keeps the first start time.
      enforceStartedAt: sql`COALESCE(${aicoLedgerState.enforceStartedAt}, now())`,
      snapshotCompletedAt: sql`now()`,
      updatedAt: new Date(),
    })
    .where(eq(aicoLedgerState.id, LEDGER_STATE_ID));
  invalidateLedgerStateCache();

  const [summary] = await db
    .select({
      degradedWallets: sql<string>`COUNT(*) FILTER (WHERE ${userWallets.lastSyncStatus} = 'degraded')`,
      overdrawnWallets: sql<string>`COUNT(*) FILTER (WHERE ${userWallets.rawUsedMicroUsd} > ${userWallets.rawCapacityMicroUsd})`,
      totalRawAvailable: sql<string>`COALESCE(SUM(GREATEST(${userWallets.rawCapacityMicroUsd} - ${userWallets.rawUsedMicroUsd}, 0)), 0)`,
    })
    .from(userWallets);

  return {
    body: {
      degradedWallets: Number(summary?.degradedWallets ?? 0),
      overdrawnWallets: Number(summary?.overdrawnWallets ?? 0),
      totalRawAvailable: Number(summary?.totalRawAvailable ?? 0),
    },
    status: 200,
  };
};

/**
 * One step of the enforce cutover snapshot. Wallets and budgets page through a
 * persisted cursor, so a failed or interrupted call is simply rerun.
 */
export const runLedgerSnapshotPhase = async (
  db: LobeChatDatabase,
  params: { keyService?: SnapshotKeyService; limit?: number; phase: SnapshotPhase },
): Promise<SnapshotResponse> => {
  const blocked = await checkPreconditions(db);
  if (blocked) return blocked;

  if (params.phase === 'finalize') return finalize(db);

  const limit = Math.min(
    SNAPSHOT_MAX_LIMIT,
    Math.max(1, Math.trunc(params.limit ?? SNAPSHOT_DEFAULT_LIMIT)),
  );
  const keyService = params.keyService ?? new AicoOpenRouterKeyService(db);
  const state = await getLedgerState(db, { fresh: true });

  return params.phase === 'wallets'
    ? snapshotWallets(db, { cursor: state.snapshotWalletsCursor ?? null, keyService, limit })
    : snapshotBudgets(db, { cursor: state.snapshotBudgetsCursor ?? null, keyService, limit });
};
