import { createHash } from 'node:crypto';

import { and, asc, eq, inArray, isNotNull, lt, lte, ne, notInArray, or, sql } from 'drizzle-orm';

import { AicoBillingModel } from '@/database/models/aicoBilling';
import {
  OrganizationModel,
  parseReclaimSnapshot,
  reclaimSnapshotOf,
  reclaimSnapshotsEqual,
} from '@/database/models/organization';
import {
  aicoKeyOutbox,
  aicoRenewalBatches,
  memberBudgets,
  organizationMembers,
  organizations,
  walletTransactions,
} from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import {
  type BudgetPeriod,
  confirmedUnusedMicro,
  periodToOpenRouterLimitReset,
} from '@/database/utils/aicoMoney';
import { aicoEnv } from '@/envs/aico';
import { AicoOpenRouterKeyService } from '@/server/services/openrouter/keyService';

import { isLedgerAuthoritative, isLedgerPaused } from './ledger/state';
import { computePeriodWindow } from './periodBoundaries';
import { sendSecurityAlert } from './securityAlert';

/** Outbox retry schedule: 1m, 2m, 4m … capped at 6h, then parked as `failed`. */
const OUTBOX_BASE_DELAY_MS = 60_000;
const OUTBOX_MAX_DELAY_MS = 6 * 60 * 60 * 1000;
const OUTBOX_MAX_ATTEMPTS = 12;
const OUTBOX_DEFAULT_BATCH = 25;
/**
 * How long a row waits when the managed provider has no route for its action.
 * That is not a failure — nothing was attempted — so the row keeps its attempt
 * count and its place in the queue rather than burning retries towards an alert.
 */
const OUTBOX_DEFER_MS = 24 * 60 * 60 * 1000;
/** A `processing` row older than this was claimed by a worker that died. */
const OUTBOX_STALE_PROCESSING_MS = 15 * 60 * 1000;
/** How long a failed renewal batch waits before the next attempt (R11). */
const FAILED_RETRY_MS = 15 * 60 * 1000;
/**
 * A `pending` batch this old belongs to a worker that died (R4). The money move
 * is a single transaction that also sets `funded`, so a `pending` batch never
 * committed money and is safe to take over.
 */
const STALE_PENDING_MS = 30 * 60 * 1000;
/** Delay before the backstop key sync that follows a funded renewal (R10). */
const KEY_SYNC_BACKSTOP_MS = 5 * 60 * 1000;

export interface RenewalOptions {
  keyService?: AicoOpenRouterKeyService;
  now?: Date;
}

export interface OrgRenewalResult {
  batchKey: string;
  grossRequiredMicroUsd: number;
  memberCount: number;
  orgId: string;
  refundedMicroUsd: number;
  shortfallMicroUsd: number;
  status: 'funded' | 'failed' | 'skipped';
}

interface DueBudget {
  budgetId: string;
  currentPeriod: BudgetPeriod;
  /** Active-cycle cap (OR limit source) — never includes pending hold. */
  currentPeriodAmountMicroUsd: number;
  keyId: string | null;
  memberId: string;
  nextPeriod: BudgetPeriod;
  nextPeriodAmountMicroUsd: number;
  nextRenewalAt: Date;
  orgId: string;
  /**
   * Already CAS-debited at allocate for a queued period change.
   * Renewal must not charge this again (AICO-140 prepaid-once).
   */
  prepaidMicroUsd: number;
}

const backoffMs = (attempts: number): number =>
  Math.min(OUTBOX_BASE_DELAY_MS * 2 ** Math.max(0, attempts - 1), OUTBOX_MAX_DELAY_MS);

/**
 * Renews every member budget whose period boundary has passed.
 *
 * Money safety: per org, the whole cycle is one all-or-none batch keyed by
 * `org + boundary` — a unique `batch_key` makes a concurrent/duplicate run a
 * no-op, and the org wallet debit is a compare-and-swap so a partially funded
 * roster can never exist. If the wallet cannot cover the net renewal debit
 * (next caps minus amounts already prepaid on period-change), no member is
 * funded and every key in the batch is disabled via the outbox.
 *
 * Failed batches delete their `batch_key` row on the next attempt so top-up +
 * re-run can recover (AICO-140).
 */
export const processDueRenewals = async (
  db: LobeChatDatabase,
  options: RenewalOptions = {},
): Promise<OrgRenewalResult[]> => {
  // The ledger pause is the cutover's maintenance window: no money moves.
  if (await isLedgerPaused(db)) return [];
  const now = options.now ?? new Date();
  const keyService = options.keyService ?? new AicoOpenRouterKeyService(db);

  await retryRenewalKeySync(db, keyService);

  const rows = await db
    .select({ budget: memberBudgets, member: organizationMembers })
    .from(memberBudgets)
    .innerJoin(organizationMembers, eq(organizationMembers.id, memberBudgets.orgMemberId))
    .innerJoin(organizations, eq(organizations.id, organizationMembers.orgId))
    .where(
      and(
        // N5: a suspended or deleted org moves no money and has no key unfrozen.
        // Its budgets stay due and renew once it is active again.
        aicoEnv.AICO_FIX_S2_RENEWAL_BATCH ? eq(organizations.status, 'active') : undefined,
        // `total` budgets never reset — they are settled manually on revoke/remove.
        ne(memberBudgets.period, 'total'),
        isNotNull(memberBudgets.nextRenewalAt),
        lte(memberBudgets.nextRenewalAt, now),
        // R1: a member who is leaving or has left is reclaimed, never renewed —
        // renewing them re-debits the org every cycle for someone who is gone.
        aicoEnv.AICO_FIX_R1_FROZEN_RECLAIM
          ? notInArray(organizationMembers.status, ['left', 'revocation_pending'])
          : undefined,
        or(
          eq(memberBudgets.isActive, true),
          // Allow retry after insufficient-balance / settlement failure.
          eq(memberBudgets.renewalStatus, 'renewal_failed'),
        ),
      ),
    );

  const byOrg = new Map<string, DueBudget[]>();
  for (const row of rows) {
    const prepaidMicroUsd = Number(row.budget.pendingPeriodAmountMicroUsd ?? 0);
    const nextPeriod = (row.budget.pendingPeriod ?? row.budget.period) as BudgetPeriod;
    const nextPeriodAmountMicroUsd =
      prepaidMicroUsd > 0 ? prepaidMicroUsd : Number(row.budget.periodAmountMicroUsd ?? 0);
    const due: DueBudget = {
      budgetId: row.budget.id,
      currentPeriod: row.budget.period as BudgetPeriod,
      currentPeriodAmountMicroUsd: Number(row.budget.periodAmountMicroUsd ?? 0),
      keyId: row.budget.openrouterKeyId ?? null,
      memberId: row.budget.orgMemberId,
      nextPeriod,
      nextPeriodAmountMicroUsd,
      nextRenewalAt: row.budget.nextRenewalAt!,
      orgId: row.member.orgId,
      prepaidMicroUsd,
    };
    const list = byOrg.get(due.orgId);
    if (list) list.push(due);
    else byOrg.set(due.orgId, [due]);
  }

  const results: OrgRenewalResult[] = [];
  for (const [orgId, budgets] of byOrg) {
    results.push(await renewOrg({ budgets, db, keyService, now, orgId }));
  }
  return results;
};

/**
 * Finish renewals that funded the new cycle but could not sync the key.
 *
 * `renewOrg` step 3 marks such a budget `renewal_failed` while leaving it
 * active: the org has already paid for the cycle, but chat refuses the member
 * and nothing revisits it before the next boundary. `failBatch` always sets
 * `isActive = false`, so "active and failed" is this case alone. Each pass
 * re-opens the budget and runs the key sync again; a sync that still throws
 * puts the budget back the way it was.
 */
export const retryRenewalKeySync = async (
  db: LobeChatDatabase,
  keyService: AicoOpenRouterKeyService,
): Promise<{ failed: number; synced: number }> => {
  const stuck = await db
    .select({ id: memberBudgets.id, orgMemberId: memberBudgets.orgMemberId })
    .from(memberBudgets)
    .where(
      and(eq(memberBudgets.isActive, true), eq(memberBudgets.renewalStatus, 'renewal_failed')),
    );

  let failed = 0;
  let synced = 0;
  for (const budget of stuck) {
    // `ensureMemberKey` leaves a failed renewal's key alone, so re-open first.
    const [claimed] = await db
      .update(memberBudgets)
      .set({ renewalStatus: 'active' })
      .where(
        and(
          eq(memberBudgets.id, budget.id),
          eq(memberBudgets.isActive, true),
          eq(memberBudgets.renewalStatus, 'renewal_failed'),
        ),
      )
      .returning({ id: memberBudgets.id });
    if (!claimed) continue;

    try {
      await keyService.ensureMemberKey(budget.orgMemberId);
      synced += 1;
    } catch (error) {
      console.error('[aico] renewal key sync retry failed', budget.orgMemberId, error);
      await db
        .update(memberBudgets)
        .set({ renewalStatus: 'renewal_failed' })
        .where(eq(memberBudgets.id, budget.id));
      failed += 1;
    }
  }
  return { failed, synced };
};

type RenewalBatchRow = typeof aicoRenewalBatches.$inferSelect;

/**
 * Takes the batch for this run, or returns why it could not.
 *
 * With the stage-B fix the claim is a compare-and-swap under a lease: the
 * worker writes its own `lease` (a millisecond-precision date) as the batch's
 * `updated_at`, and every later write of the run is conditional on that value,
 * so a worker whose batch was taken over cannot move money or fail it.
 */
const claimRenewalBatch = async (params: {
  batchKey: string;
  budgetIds: string[];
  db: LobeChatDatabase;
  grossRequiredMicroUsd: number;
  lease: Date;
  orgId: string;
}): Promise<RenewalBatchRow | 'funded' | null> => {
  const { batchKey, budgetIds, db, grossRequiredMicroUsd, lease, orgId } = params;
  const staged = aicoEnv.AICO_FIX_S2_RENEWAL_BATCH;

  const tryInsert = async () => {
    const [row] = await db
      .insert(aicoRenewalBatches)
      .values({
        batchKey,
        grossRequiredMicroUsd,
        memberBudgetIds: budgetIds,
        orgId,
        status: 'pending',
        // Written explicitly: the database default has microseconds, which a
        // millisecond lease could never match.
        ...(staged ? { updatedAt: lease } : {}),
      })
      .onConflictDoNothing({ target: aicoRenewalBatches.batchKey })
      .returning();
    return row ?? null;
  };

  const inserted = await tryInsert();
  if (inserted) return inserted;

  const existing = await db.query.aicoRenewalBatches.findFirst({
    where: eq(aicoRenewalBatches.batchKey, batchKey),
  });
  if (!existing) return null;

  if (!staged) {
    if (existing.status !== 'failed') return null;
    // Prior attempt failed (e.g. shortfall). Drop the unique key so a funded retry can proceed.
    await db.delete(aicoRenewalBatches).where(eq(aicoRenewalBatches.id, existing.id));
    return tryInsert();
  }

  if (existing.status === 'funded') return 'funded';

  // FIN-028 / R4 / R11: one conditional UPDATE keeps the row (and its history),
  // lets exactly one of two racing workers win, and enforces the waits.
  const [claimed] = await db
    .update(aicoRenewalBatches)
    .set({
      error: null,
      grossRequiredMicroUsd,
      memberBudgetIds: budgetIds,
      refundedMicroUsd: 0,
      shortfallMicroUsd: 0,
      status: 'pending',
      updatedAt: lease,
    })
    .where(
      and(
        eq(aicoRenewalBatches.id, existing.id),
        or(
          and(
            eq(aicoRenewalBatches.status, 'failed'),
            lte(aicoRenewalBatches.updatedAt, new Date(lease.getTime() - FAILED_RETRY_MS)),
          ),
          and(
            eq(aicoRenewalBatches.status, 'pending'),
            lte(aicoRenewalBatches.updatedAt, new Date(lease.getTime() - STALE_PENDING_MS)),
          ),
        ),
      ),
    )
    .returning();
  return claimed ?? null;
};

/**
 * Names the batch by the exact set of budgets it renews. A stale budget that
 * joins an org's due set changes the key, so it can never collide with a batch
 * that already funded the others (R3), while a retry of the same set keeps its
 * key and re-claims its own row.
 */
const batchKeyFor = (orgId: string, boundary: number, budgetIds: string[]): string => {
  const base = `${orgId}:${new Date(boundary).toISOString()}`;
  if (!aicoEnv.AICO_FIX_S2_RENEWAL_BATCH || !aicoEnv.AICO_FIX_R5_RENEWAL_LOCK) return base;
  const fingerprint = createHash('sha256')
    .update([...budgetIds].sort().join(','))
    .digest('hex')
    .slice(0, 16);
  return `${base}:${fingerprint}`;
};

const renewOrg = async (params: {
  budgets: DueBudget[];
  db: LobeChatDatabase;
  keyService: AicoOpenRouterKeyService;
  now: Date;
  orgId: string;
}): Promise<OrgRenewalResult> => {
  const { budgets, db, keyService, now, orgId } = params;

  const boundary = budgets
    .map((b) => b.nextRenewalAt.getTime())
    .reduce((min, t) => Math.min(min, t), Number.POSITIVE_INFINITY);
  const budgetIds = budgets.map((b) => b.budgetId);
  const batchKey = batchKeyFor(orgId, boundary, budgetIds);
  // The claim's lease: a whole-millisecond date this worker stamps on the batch
  // and conditions every later write on (see `claimRenewalBatch`).
  const lease = new Date(now.getTime());
  // Wallet debit excludes amounts already prepaid when queuing a period change.
  const walletDebitByMember = new Map<string, number>();
  for (const b of budgets) {
    walletDebitByMember.set(
      b.memberId,
      Math.max(0, b.nextPeriodAmountMicroUsd - b.prepaidMicroUsd),
    );
  }
  const grossRequiredMicroUsd = [...walletDebitByMember.values()].reduce((sum, v) => sum + v, 0);
  // AICO-180: a fresh cycle meters from zero at whatever multiplier is in force
  // now, so stamp it here rather than leaving a stale rate to trigger a rebase.
  const currentMultiplierBp = await new AicoBillingModel(db).getUsageMultiplierBp();

  const skippedResult = () => ({
    batchKey,
    grossRequiredMicroUsd,
    memberCount: budgets.length,
    orgId,
    refundedMicroUsd: 0,
    shortfallMicroUsd: 0,
    status: 'skipped' as const,
  });

  const batch = await claimRenewalBatch({
    batchKey,
    budgetIds,
    db,
    grossRequiredMicroUsd,
    lease,
    orgId,
  });

  if (batch === 'funded') {
    // The fingerprint names this exact set, so it was funded yet is due again:
    // the books and the budget windows disagree. Nothing is moved; say so.
    await sendSecurityAlert(db, {
      dedupeKey: `renewal.inconsistent_due:${batchKey}`,
      details: { batchKey, budgetIds, orgId },
      severity: 'warning',
      summary: `Org ${orgId} has budgets due that an already-funded renewal batch covers`,
      type: 'renewal.inconsistent_due',
    });
  }

  if (!batch || batch === 'funded') return skippedResult();

  // R11: a budget already `renewal_failed` was frozen by the run that failed it;
  // freezing it and queueing another disable on every retry only adds traffic.
  const alreadyFailed = new Set<string>();
  if (aicoEnv.AICO_FIX_S2_RENEWAL_BATCH) {
    const rows = await db
      .select({ id: memberBudgets.id })
      .from(memberBudgets)
      .where(
        and(
          inArray(memberBudgets.id, budgetIds),
          eq(memberBudgets.renewalStatus, 'renewal_failed'),
        ),
      );
    for (const row of rows) alreadyFailed.add(row.id);
  }

  // Deny chat + disable OR keys while the boundary settles.
  await db
    .update(memberBudgets)
    .set({ isActive: true, renewalStatus: 'renewal_pending' })
    .where(
      and(
        inArray(memberBudgets.id, budgetIds),
        // R5: only budgets still in the state the due query selected. A revoke
        // that settled one since must not be pulled back into renewal — the
        // funding transaction then sees it is not pending and abandons the
        // batch, and `failBatch` leaves it settled.
        aicoEnv.AICO_FIX_R5_RENEWAL_LOCK
          ? or(eq(memberBudgets.isActive, true), eq(memberBudgets.renewalStatus, 'renewal_failed'))
          : undefined,
      ),
    );

  await Promise.all(
    budgets.map(async (b) => {
      if (alreadyFailed.has(b.budgetId)) return;
      try {
        await keyService.disableMemberKey(b.memberId);
      } catch (error) {
        console.warn('[aico] disableMemberKey at renewal start failed', b.memberId, error);
      }
    }),
  );

  const failResult = (shortfallMicroUsd: number) => ({
    batchKey,
    grossRequiredMicroUsd,
    memberCount: budgets.length,
    orgId,
    refundedMicroUsd: 0,
    shortfallMicroUsd,
    status: 'failed' as const,
  });

  const failBatch = async (error: string, shortfallMicroUsd = 0) => {
    if (aicoEnv.AICO_FIX_S2_RENEWAL_BATCH) {
      // Fail the batch first, and only while this worker still holds its lease:
      // when another worker has taken the batch over, this run owns nothing.
      const [owned] = await db
        .update(aicoRenewalBatches)
        .set({ error, shortfallMicroUsd, status: 'failed', updatedAt: lease })
        .where(
          and(
            eq(aicoRenewalBatches.id, batch.id),
            eq(aicoRenewalBatches.status, 'pending'),
            eq(aicoRenewalBatches.updatedAt, lease),
          ),
        )
        .returning({ id: aicoRenewalBatches.id });
      if (!owned) return skippedResult();

      const failed = await db
        .update(memberBudgets)
        .set({ isActive: false, renewalStatus: 'renewal_failed' })
        .where(
          and(
            inArray(memberBudgets.id, budgetIds),
            // R5: a budget revoked or re-allocated mid-renewal is no longer ours to
            // fail — marking it `renewal_failed` would pull a settled budget back
            // into the next renewal.
            aicoEnv.AICO_FIX_R5_RENEWAL_LOCK
              ? eq(memberBudgets.renewalStatus, 'renewal_pending')
              : undefined,
          ),
        )
        .returning({ id: memberBudgets.id });
      // R9 / R11: queue a disable only for budgets this run actually failed and
      // that were not already frozen by an earlier failed run.
      const toDisable = new Set(failed.map((row) => row.id));
      for (const id of alreadyFailed) toDisable.delete(id);
      const disableRows = budgets.filter((b) => toDisable.has(b.budgetId));
      if (disableRows.length > 0) {
        await db.insert(aicoKeyOutbox).values(
          disableRows.map((b) => ({
            action: 'disable_member_key',
            nextAttemptAt: now,
            orgId,
            orgMemberId: b.memberId,
            payload: { batchKey, reason: error },
            status: 'pending',
          })),
        );
      }
      return failResult(shortfallMicroUsd);
    }

    await db
      .update(memberBudgets)
      .set({ isActive: false, renewalStatus: 'renewal_failed' })
      .where(
        and(
          inArray(memberBudgets.id, budgetIds),
          // R5: a budget revoked or re-allocated mid-renewal is no longer ours to
          // fail — marking it `renewal_failed` would pull a settled budget back
          // into the next renewal.
          aicoEnv.AICO_FIX_R5_RENEWAL_LOCK
            ? eq(memberBudgets.renewalStatus, 'renewal_pending')
            : undefined,
        ),
      );
    await db.insert(aicoKeyOutbox).values(
      budgets.map((b) => ({
        action: 'disable_member_key',
        nextAttemptAt: now,
        orgId,
        orgMemberId: b.memberId,
        payload: { batchKey, reason: error },
        status: 'pending',
      })),
    );
    await db
      .update(aicoRenewalBatches)
      .set({ error, shortfallMicroUsd, status: 'failed' })
      .where(eq(aicoRenewalBatches.id, batch.id));

    return failResult(shortfallMicroUsd);
  };

  // 1. Authoritative settlement of the closing period (OpenRouter is the source
  //    of truth for spend). Any read failure fails the batch — never guess usage.
  const refunds = new Map<string, number>();
  // Where each member's meter restarts. Zero on a provider whose key counters
  // reset at the boundary; the counter's settled value on one whose do not —
  // see `AicoOpenRouterKeyService.settleMemberPeriod`.
  const nextBaselines = new Map<string, number>();
  // A key's remaining allowance is one pot of money: refund it to one budget only.
  const refundedBudgetByKey = new Map<string, string>();
  const duplicateKeys: { budgetId: string; keyId: string; refundedBudgetId: string }[] = [];
  const overCap: { budgetId: string; capMicroUsd: number; reportedMicroUsd: number }[] = [];
  try {
    for (const b of budgets) {
      const settled = await keyService.settleMemberPeriod(b.memberId);
      nextBaselines.set(b.memberId, settled?.nextCycleBaselineMicroUsd ?? 0);

      const refundedBudgetId = b.keyId ? refundedBudgetByKey.get(b.keyId) : undefined;
      if (b.keyId && refundedBudgetId) {
        duplicateKeys.push({ budgetId: b.budgetId, keyId: b.keyId, refundedBudgetId });
        refunds.set(b.memberId, 0);
        continue;
      }
      if (b.keyId) refundedBudgetByKey.set(b.keyId, b.budgetId);

      const usage = BigInt(settled?.usageMicroUsd ?? 0);
      // Never refund from reserved (may include pending), and never more than
      // this cycle funded. Prefer OR remaining; fall back to cap − usage.
      const cap = confirmedUnusedMicro(BigInt(b.currentPeriodAmountMicroUsd), usage);
      const reported =
        settled?.remainingMicroUsd == null
          ? cap
          : BigInt(Math.max(0, Math.floor(settled.remainingMicroUsd)));
      if (reported > cap) {
        overCap.push({
          budgetId: b.budgetId,
          capMicroUsd: Number(cap),
          reportedMicroUsd: Number(reported),
        });
      }
      refunds.set(b.memberId, Number(reported > cap ? cap : reported));
    }
  } catch (error) {
    return failBatch(`SETTLEMENT_FAILED:${error instanceof Error ? error.message : String(error)}`);
  }

  if (duplicateKeys.length > 0) {
    await sendSecurityAlert(db, {
      dedupeKey: `renewal.duplicate_key:${batchKey}`,
      details: { batchKey, duplicates: duplicateKeys, orgId },
      severity: 'critical',
      summary: `Renewal found ${duplicateKeys.length} budget(s) sharing a key in org ${orgId}; refunded each key once`,
      type: 'renewal.duplicate_key',
    });
  }
  if (overCap.length > 0) {
    await sendSecurityAlert(db, {
      dedupeKey: `renewal.refund_over_cap:${batchKey}`,
      details: { batchKey, budgets: overCap, orgId },
      severity: 'warning',
      summary: `Renewal clamped ${overCap.length} refund(s) above the funded cycle cap in org ${orgId}`,
      type: 'renewal.refund_over_cap',
    });
  }

  const refundedMicroUsd = [...refunds.values()].reduce((sum, v) => sum + v, 0);

  // 2. Refund confirmed-unused credit, then CAS-debit only the unfunded next-cap slice.
  try {
    await db.transaction(async (tx) => {
      // The funding transaction starts by marking the batch funded under this
      // worker's lease. A worker whose batch was taken over finds no row and
      // moves nothing; the row stays locked until commit, so the takeover
      // worker waits here instead of double-funding.
      if (aicoEnv.AICO_FIX_S2_RENEWAL_BATCH) {
        const [owned] = await tx
          .update(aicoRenewalBatches)
          .set({ status: 'funded', updatedAt: lease })
          .where(
            and(
              eq(aicoRenewalBatches.id, batch.id),
              eq(aicoRenewalBatches.status, 'pending'),
              eq(aicoRenewalBatches.updatedAt, lease),
            ),
          )
          .returning({ id: aicoRenewalBatches.id });
        if (!owned) throw new Error('BATCH_CLAIM_LOST');
      }

      // R5 (2026-10): refunds were computed from rows read before this
      // transaction. A revoke, reclaim or re-allocation that committed since
      // would be refunded a second time and its budget re-activated below, so
      // lock every budget (budgets before the org row, the order the
      // allocate and reclaim paths use) and abandon the batch if any changed.
      // The next run re-reads them.
      if (aicoEnv.AICO_FIX_R5_RENEWAL_LOCK) {
        const locked = await tx
          .select()
          .from(memberBudgets)
          .where(inArray(memberBudgets.id, budgetIds))
          .for('update');
        const read = new Map(budgets.map((b) => [b.budgetId, b]));
        const unchanged = locked.filter((row) => {
          const b = read.get(row.id);
          return (
            b !== undefined &&
            row.renewalStatus === 'renewal_pending' &&
            Number(row.periodAmountMicroUsd ?? 0) === b.currentPeriodAmountMicroUsd &&
            Number(row.pendingPeriodAmountMicroUsd ?? 0) === b.prepaidMicroUsd &&
            (row.pendingPeriod ?? row.period) === b.nextPeriod
          );
        });
        if (unchanged.length !== budgetIds.length) {
          throw new Error('BUDGETS_CHANGED_DURING_RENEWAL');
        }
      }

      // D1: locked (after the budgets) so the period_refund rows chain from the
      // balance this transaction actually moves.
      const [orgBefore] = await tx
        .select()
        .from(organizations)
        .where(eq(organizations.id, orgId))
        .limit(1)
        .for('update');
      if (!orgBefore) throw new Error('ORG_NOT_FOUND');
      // N5: suspended after the due query ran — move nothing.
      if (aicoEnv.AICO_FIX_S2_RENEWAL_BATCH && orgBefore.status !== 'active') {
        throw new Error('ORG_NOT_ACTIVE');
      }
      let runningBalanceMicroUsd = Number(orgBefore.walletBalanceMicroUsd ?? 0);

      if (refundedMicroUsd > 0) {
        await tx
          .update(organizations)
          .set({
            walletBalanceMicroUsd: sql`${organizations.walletBalanceMicroUsd} + ${refundedMicroUsd}`,
          })
          .where(eq(organizations.id, orgId));

        for (const b of budgets) {
          const amount = refunds.get(b.memberId) ?? 0;
          if (amount <= 0) continue;
          const member = await tx.query.organizationMembers.findFirst({
            where: eq(organizationMembers.id, b.memberId),
          });
          const balanceBeforeMicroUsd = runningBalanceMicroUsd;
          runningBalanceMicroUsd += amount;
          await tx.insert(walletTransactions).values({
            amountMicroUsd: amount,
            amountToman: 0,
            balanceAfterMicroUsd: runningBalanceMicroUsd,
            balanceBeforeMicroUsd,
            description: `Period refund for member ${b.memberId}`,
            orgId,
            orgMemberId: b.memberId,
            renewalBatchId: batch.id,
            type: 'period_refund',
            userId: member?.userId ?? null,
          });
        }
      }

      if (grossRequiredMicroUsd > 0) {
        const [funded] = await tx
          .update(organizations)
          .set({
            walletBalanceMicroUsd: sql`${organizations.walletBalanceMicroUsd} - ${grossRequiredMicroUsd}`,
          })
          .where(
            and(
              eq(organizations.id, orgId),
              sql`${organizations.walletBalanceMicroUsd} >= ${grossRequiredMicroUsd}`,
            ),
          )
          .returning();
        if (!funded) throw new Error('INSUFFICIENT_ORG_BALANCE');
        runningBalanceMicroUsd = Number(funded.walletBalanceMicroUsd ?? 0);
      } else {
        const [fresh] = await tx
          .select()
          .from(organizations)
          .where(eq(organizations.id, orgId))
          .limit(1);
        runningBalanceMicroUsd = Number(fresh?.walletBalanceMicroUsd ?? 0);
      }

      let attributed = runningBalanceMicroUsd + grossRequiredMicroUsd;
      for (const b of budgets) {
        const window = computePeriodWindow(b.nextPeriod, now);
        await tx
          .update(memberBudgets)
          .set({
            currentPeriodEnd: window.end,
            currentPeriodStart: window.start,
            isActive: true,
            nextRenewalAt: window.nextRenewalAt,
            openrouterLimitReset: periodToOpenRouterLimitReset(b.nextPeriod),
            pendingPeriod: null,
            pendingPeriodAmountMicroUsd: null,
            period: b.nextPeriod,
            periodAmountMicroUsd: b.nextPeriodAmountMicroUsd,
            refundedMicroUsd: sql`${memberBudgets.refundedMicroUsd} + ${refunds.get(b.memberId) ?? 0}`,
            renewalStatus: 'active',
            reservedMicroUsd: b.nextPeriodAmountMicroUsd,
            settledUsageMicroUsd: 0,
            // AICO-180: the multiplier checkpoint is cycle-scoped — reset it with
            // settled usage so the new cycle meters from zero at the current rate.
            billedUsageBeforeBaselineMicroUsd: 0,
            checkpointMultiplierBp: currentMultiplierBp,
            usageBaselineMicroUsd: nextBaselines.get(b.memberId) ?? 0,
            // The one place settled usage resets. Holds opened in the closing
            // cycle were refunded at full value, so their settle must not land
            // in the new cycle; held and open_holds stay as they are.
            ledgerEpoch: sql`${memberBudgets.ledgerEpoch} + 1`,
          })
          .where(eq(memberBudgets.id, b.budgetId));

        const debit = walletDebitByMember.get(b.memberId) ?? 0;
        if (debit <= 0) continue;

        const member = await tx.query.organizationMembers.findFirst({
          where: eq(organizationMembers.id, b.memberId),
        });
        const balanceBeforeMicroUsd = attributed;
        attributed -= debit;
        await tx.insert(walletTransactions).values({
          amountMicroUsd: debit,
          amountToman: 0,
          balanceAfterMicroUsd: attributed,
          balanceBeforeMicroUsd,
          description: `Period renewal for member ${b.memberId}`,
          orgId,
          orgMemberId: b.memberId,
          renewalBatchId: batch.id,
          type: 'period_renewal',
          userId: member?.userId ?? null,
        });
      }

      await tx
        .update(aicoRenewalBatches)
        .set({
          refundedMicroUsd,
          status: 'funded',
          ...(aicoEnv.AICO_FIX_S2_RENEWAL_BATCH ? { updatedAt: lease } : {}),
        })
        .where(eq(aicoRenewalBatches.id, batch.id));

      // R10: a backstop for step 3. If the process dies between this commit and
      // the key sync, the member is paid up but their key is still frozen, and
      // nothing else revisits them. The row is an idempotent `ensureMemberKey`.
      if (aicoEnv.AICO_FIX_S2_RENEWAL_BATCH) {
        await tx.insert(aicoKeyOutbox).values(
          budgets.map((b) => ({
            action: 'sync_member_key',
            nextAttemptAt: new Date(now.getTime() + KEY_SYNC_BACKSTOP_MS),
            orgId,
            orgMemberId: b.memberId,
            payload: { batchKey },
            status: 'pending',
          })),
        );
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === 'BATCH_CLAIM_LOST') return skippedResult();
    if (message === 'INSUFFICIENT_ORG_BALANCE') {
      const org = await db.query.organizations.findFirst({ where: eq(organizations.id, orgId) });
      const balance = Number(org?.walletBalanceMicroUsd ?? 0);
      return failBatch('INSUFFICIENT_ORG_BALANCE', Math.max(0, grossRequiredMicroUsd - balance));
    }
    return failBatch(`RENEWAL_FAILED:${message}`);
  }

  // 3. Push the new limit + limit_reset to OpenRouter (re-enables funded keys).
  for (const b of budgets) {
    try {
      await keyService.ensureMemberKey(b.memberId);
    } catch (error) {
      console.error('[aico] renewal key sync failed', b.memberId, error);
      await db
        .update(memberBudgets)
        .set({ renewalStatus: 'renewal_failed' })
        .where(eq(memberBudgets.id, b.budgetId));
      await db.insert(aicoKeyOutbox).values({
        action: 'disable_member_key',
        nextAttemptAt: now,
        orgId,
        orgMemberId: b.memberId,
        payload: { batchKey, reason: 'KEY_SYNC_FAILED' },
        status: 'pending',
      });
    }
  }

  return {
    batchKey,
    grossRequiredMicroUsd,
    memberCount: budgets.length,
    orgId,
    refundedMicroUsd,
    shortfallMicroUsd: 0,
    status: 'funded',
  };
};

export interface OutboxRunResult {
  /** Parked because the live provider cannot perform the action yet. */
  deferred: number;
  failed: number;
  processed: number;
  succeeded: number;
}

/**
 * Drains the durable OpenRouter key outbox with exponential backoff.
 *
 * Local access removal (member removal, failed renewal) is committed
 * immediately; disabling the OpenRouter key and reclaiming credit happen here,
 * so OpenRouter downtime delays settlement but never blocks revocation.
 */
export const processKeyOutbox = async (
  db: LobeChatDatabase,
  options: { keyService?: AicoOpenRouterKeyService; limit?: number; now?: Date } = {},
): Promise<OutboxRunResult> => {
  if (await isLedgerPaused(db)) return { deferred: 0, failed: 0, processed: 0, succeeded: 0 };
  const now = options.now ?? new Date();
  const keyService = options.keyService ?? new AicoOpenRouterKeyService(db);
  const orgModel = new OrganizationModel(db);

  // N6: a worker that died after claiming a row leaves it `processing` for
  // good. Once it is old enough that no live worker can still be on it, it is
  // claimable again — until its attempts run out, like any other row.
  const staleCutoff = new Date(now.getTime() - OUTBOX_STALE_PROCESSING_MS);
  const stale = aicoEnv.AICO_FIX_S2_RENEWAL_BATCH
    ? and(
        eq(aicoKeyOutbox.status, 'processing'),
        lte(aicoKeyOutbox.updatedAt, staleCutoff),
        lt(aicoKeyOutbox.attempts, OUTBOX_MAX_ATTEMPTS),
      )
    : undefined;

  const candidates = await db
    .select({ id: aicoKeyOutbox.id })
    .from(aicoKeyOutbox)
    .where(
      or(and(eq(aicoKeyOutbox.status, 'pending'), lte(aicoKeyOutbox.nextAttemptAt, now)), stale),
    )
    .orderBy(asc(aicoKeyOutbox.nextAttemptAt))
    .limit(options.limit ?? OUTBOX_DEFAULT_BATCH);

  let processed = 0;
  let succeeded = 0;
  let failed = 0;
  let deferred = 0;

  for (const candidate of candidates) {
    // Claim with a compare-and-swap so parallel workers never double-process.
    const [row] = await db
      .update(aicoKeyOutbox)
      .set({
        attempts: sql`${aicoKeyOutbox.attempts} + 1`,
        status: 'processing',
        ...(stale ? { updatedAt: now } : {}),
      })
      .where(
        and(eq(aicoKeyOutbox.id, candidate.id), or(eq(aicoKeyOutbox.status, 'pending'), stale)),
      )
      .returning();
    if (!row) continue;

    processed += 1;
    try {
      const outcome = await runOutboxAction({ db, keyService, orgModel, row });

      if (outcome === 'unsupported') {
        // Terminal but not a failure: nothing can perform this job, so it must
        // neither retry nor raise an exhaustion alert.
        await db
          .update(aicoKeyOutbox)
          .set({ lastError: 'UNSUPPORTED_BY_PROVIDER', status: 'unsupported' })
          .where(eq(aicoKeyOutbox.id, row.id));
        continue;
      }

      if (outcome === 'deferred') {
        // Hand the attempt back: the row is a standing record of work the
        // provider cannot do yet, not a failing job.
        await db
          .update(aicoKeyOutbox)
          .set({
            attempts: sql`greatest(${aicoKeyOutbox.attempts} - 1, 0)`,
            nextAttemptAt: new Date(now.getTime() + OUTBOX_DEFER_MS),
            status: 'pending',
          })
          .where(eq(aicoKeyOutbox.id, row.id));
        deferred += 1;
        continue;
      }

      await db
        .update(aicoKeyOutbox)
        .set({ lastError: null, status: 'succeeded' })
        .where(eq(aicoKeyOutbox.id, row.id));
      succeeded += 1;
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      const exhausted = row.attempts >= OUTBOX_MAX_ATTEMPTS;
      await db
        .update(aicoKeyOutbox)
        .set({
          alertedAt: exhausted ? now : null,
          lastError: message.slice(0, 500),
          nextAttemptAt: new Date(now.getTime() + backoffMs(row.attempts)),
          status: exhausted ? 'failed' : 'pending',
        })
        .where(eq(aicoKeyOutbox.id, row.id));
      if (exhausted) {
        console.error('[aico] key outbox entry exhausted retries', row.id, row.action, message);
        await sendSecurityAlert(db, {
          dedupeKey: `outbox.exhausted:${row.id}`,
          details: {
            action: row.action,
            attempts: row.attempts,
            outboxId: row.id,
          },
          severity: 'critical',
          summary: `Key outbox entry exhausted retries (${row.action})`,
          type: 'outbox.exhausted',
        });
      }
    }
  }

  return { deferred, failed, processed, succeeded };
};

/**
 * `'deferred'` means the action is still owed but the live managed provider has
 * no route for it — see `OUTBOX_DEFER_MS`. `'unsupported'` means it never can be.
 */
const runOutboxAction = async (params: {
  db: LobeChatDatabase;
  keyService: AicoOpenRouterKeyService;
  orgModel: OrganizationModel;
  row: typeof aicoKeyOutbox.$inferSelect;
}): Promise<'done' | 'deferred' | 'unsupported'> => {
  const { db, keyService, orgModel, row } = params;

  switch (row.action) {
    case 'disable_member_key': {
      if (!row.orgMemberId) throw new Error('ORG_MEMBER_ID_REQUIRED');
      // R9: a renewal queues this when it fails, and it can run long after the
      // budget was funded again — freezing a key the org has just paid for. Rows
      // written by removal carry no batch key and always run.
      if (aicoEnv.AICO_FIX_S2_RENEWAL_BATCH && row.payload?.batchKey) {
        const budget = await orgModel.getMemberBudget(row.orgMemberId);
        if (budget?.isActive && budget.renewalStatus === 'active') return 'done';
      }
      await keyService.disableMemberKey(row.orgMemberId);
      return 'done';
    }

    /** Backstop for a renewal that funded the cycle (R10): idempotent. */
    case 'sync_member_key': {
      if (!row.orgMemberId) throw new Error('ORG_MEMBER_ID_REQUIRED');
      const ensured = await keyService.ensureMemberKey(row.orgMemberId);
      // N7 / R8: the key was not read or its edit's outcome is unknown — retry.
      if (ensured?.unverified) throw new Error('KEY_SYNC_UNVERIFIED');
      return 'done';
    }

    /**
     * A key we stopped using but could not revoke, recorded by
     * `retireManagedKey`. CheapVibeCode deletes a key only by its secret, which
     * this row does not hold, so its rows end `unsupported`: an inventory of
     * live-but-unused keys for the provider's support to remove.
     */
    case 'revoke_managed_key': {
      if (!row.openrouterKeyId) throw new Error('MANAGED_KEY_ID_REQUIRED');
      return keyService.revokeManagedKeyById(row.openrouterKeyId);
    }

    // OR-001: soft-delete enqueues disable_user_key; must actually disable the personal OR key.
    case 'disable_user_key': {
      if (!row.userId) throw new Error('USER_ID_REQUIRED');
      await keyService.disableUserKey(row.userId);
      return 'done';
    }

    // FIN-013: a credit commits before its key limit is pushed. When that push
    // fails the wallet is funded behind a stale limit, so the retry lands here
    // rather than being reported to the admin as a failed credit.
    case 'sync_user_key': {
      if (!row.userId) throw new Error('USER_ID_REQUIRED');
      const ensured = await keyService.ensureUserKey(row.userId);
      if (ensured?.unverified) throw new Error('KEY_SYNC_UNVERIFIED');
      return 'done';
    }

    // W2 (2026-10): an admin debit commits before the key is cut down to the
    // new balance. When that cut fails or its outcome is unknown, the retry has
    // to cut too — `ensureUserKey` only ever raises a key, so retrying with it
    // left the pre-debit limit spendable for good.
    case 'shrink_user_key': {
      if (!row.userId) throw new Error('USER_ID_REQUIRED');
      const outcome = await keyService.shrinkUserKey(row.userId);
      if (outcome.status === 'ambiguous') throw new Error('SHRINK_OUTCOME_UNKNOWN');
      if (outcome.unverified) throw new Error('SHRINK_UNVERIFIED');
      return 'done';
    }

    case 'reclaim_member': {
      if (!row.orgMemberId || !row.orgId) throw new Error('ORG_MEMBER_ID_REQUIRED');
      // A sweep that deferred its reclaim recorded the budget it saw. If the
      // budget has been re-allocated, renewed or settled since, the job is
      // stale and would reclaim a newer allocation.
      const sweepExpected = parseReclaimSnapshot(row.payload?.expected);
      if (sweepExpected) {
        const current = await orgModel.getMemberBudgetForOrg({
          orgId: row.orgId,
          orgMemberId: row.orgMemberId,
        });
        if (!current || !reclaimSnapshotsEqual(sweepExpected, reclaimSnapshotOf(current))) {
          console.warn('[aico] sweep reclaim superseded by a later change', row.orgMemberId);
          return 'done';
        }
      }
      const reclaimed = await keyService.reclaimMemberKey({
        orgId: row.orgId,
        orgMemberId: row.orgMemberId,
      });
      const createdByUserId =
        typeof row.payload?.createdByUserId === 'string' ? row.payload.createdByUserId : null;
      await orgModel.reclaimMemberRemainingCredit({
        createdByUserId,
        expected: reclaimed?.expected,
        metadata: reclaimed?.estimated ? { estimatedReclaim: reclaimed.estimated } : undefined,
        orgId: row.orgId,
        orgMemberId: row.orgMemberId,
        remainingMicroUsd: reclaimed?.remainingMicroUsd ?? 0,
        useLedgerRemaining: await isLedgerAuthoritative(db),
      });
      await orgModel.finalizeMemberRevocation(row.orgMemberId);
      return 'done';
    }

    default: {
      throw new Error(`UNSUPPORTED_OUTBOX_ACTION:${row.action}`);
    }
  }
};
