import { and, asc, eq, inArray, isNotNull, lte, ne, or, sql } from 'drizzle-orm';

import { AicoBillingModel } from '@/database/models/aicoBilling';
import { OrganizationModel } from '@/database/models/organization';
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
    .where(
      and(
        // `total` budgets never reset — they are settled manually on revoke/remove.
        ne(memberBudgets.period, 'total'),
        isNotNull(memberBudgets.nextRenewalAt),
        lte(memberBudgets.nextRenewalAt, now),
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

const claimRenewalBatch = async (params: {
  batchKey: string;
  budgetIds: string[];
  db: LobeChatDatabase;
  grossRequiredMicroUsd: number;
  orgId: string;
}) => {
  const { batchKey, budgetIds, db, grossRequiredMicroUsd, orgId } = params;

  const tryInsert = async () => {
    const [row] = await db
      .insert(aicoRenewalBatches)
      .values({
        batchKey,
        grossRequiredMicroUsd,
        memberBudgetIds: budgetIds,
        orgId,
        status: 'pending',
      })
      .onConflictDoNothing({ target: aicoRenewalBatches.batchKey })
      .returning();
    return row ?? null;
  };

  let batch = await tryInsert();
  if (batch) return batch;

  const existing = await db.query.aicoRenewalBatches.findFirst({
    where: eq(aicoRenewalBatches.batchKey, batchKey),
  });
  if (!existing) return null;
  if (existing.status !== 'failed') return null;

  // Prior attempt failed (e.g. shortfall). Drop the unique key so a funded retry can proceed.
  await db.delete(aicoRenewalBatches).where(eq(aicoRenewalBatches.id, existing.id));
  batch = await tryInsert();
  return batch;
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
  const batchKey = `${orgId}:${new Date(boundary).toISOString()}`;
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

  const budgetIds = budgets.map((b) => b.budgetId);
  const batch = await claimRenewalBatch({
    batchKey,
    budgetIds,
    db,
    grossRequiredMicroUsd,
    orgId,
  });

  if (!batch) {
    return {
      batchKey,
      grossRequiredMicroUsd,
      memberCount: budgets.length,
      orgId,
      refundedMicroUsd: 0,
      shortfallMicroUsd: 0,
      status: 'skipped',
    };
  }

  // Deny chat + disable OR keys while the boundary settles.
  await db
    .update(memberBudgets)
    .set({ isActive: true, renewalStatus: 'renewal_pending' })
    .where(inArray(memberBudgets.id, budgetIds));

  await Promise.all(
    budgets.map(async (b) => {
      try {
        await keyService.disableMemberKey(b.memberId);
      } catch (error) {
        console.warn('[aico] disableMemberKey at renewal start failed', b.memberId, error);
      }
    }),
  );

  const failBatch = async (error: string, shortfallMicroUsd = 0) => {
    await db
      .update(memberBudgets)
      .set({ isActive: false, renewalStatus: 'renewal_failed' })
      .where(inArray(memberBudgets.id, budgetIds));
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

    return {
      batchKey,
      grossRequiredMicroUsd,
      memberCount: budgets.length,
      orgId,
      refundedMicroUsd: 0,
      shortfallMicroUsd,
      status: 'failed' as const,
    };
  };

  // 1. Authoritative settlement of the closing period (OpenRouter is the source
  //    of truth for spend). Any read failure fails the batch — never guess usage.
  const refunds = new Map<string, number>();
  // Where each member's meter restarts. Zero on a provider whose key counters
  // reset at the boundary; the counter's settled value on one whose do not —
  // see `AicoOpenRouterKeyService.settleMemberPeriod`.
  const nextBaselines = new Map<string, number>();
  try {
    for (const b of budgets) {
      const settled = await keyService.settleMemberPeriod(b.memberId);
      nextBaselines.set(b.memberId, settled?.nextCycleBaselineMicroUsd ?? 0);
      const usage = BigInt(settled?.usageMicroUsd ?? 0);
      // Never refund from reserved (may include pending). Prefer OR remaining;
      // fall back to current-cycle cap − usage only.
      const unused =
        settled?.remainingMicroUsd == null
          ? confirmedUnusedMicro(BigInt(b.currentPeriodAmountMicroUsd), usage)
          : BigInt(Math.max(0, Math.floor(settled.remainingMicroUsd)));
      refunds.set(b.memberId, Number(unused));
    }
  } catch (error) {
    return failBatch(`SETTLEMENT_FAILED:${error instanceof Error ? error.message : String(error)}`);
  }

  const refundedMicroUsd = [...refunds.values()].reduce((sum, v) => sum + v, 0);

  // 2. Refund confirmed-unused credit, then CAS-debit only the unfunded next-cap slice.
  try {
    await db.transaction(async (tx) => {
      const orgBefore = await tx.query.organizations.findFirst({
        where: eq(organizations.id, orgId),
      });
      if (!orgBefore) throw new Error('ORG_NOT_FOUND');
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
        .set({ refundedMicroUsd, status: 'funded' })
        .where(eq(aicoRenewalBatches.id, batch.id));
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
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

  const candidates = await db
    .select({ id: aicoKeyOutbox.id })
    .from(aicoKeyOutbox)
    .where(and(eq(aicoKeyOutbox.status, 'pending'), lte(aicoKeyOutbox.nextAttemptAt, now)))
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
      .set({ attempts: sql`${aicoKeyOutbox.attempts} + 1`, status: 'processing' })
      .where(and(eq(aicoKeyOutbox.id, candidate.id), eq(aicoKeyOutbox.status, 'pending')))
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
      await keyService.disableMemberKey(row.orgMemberId);
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
      await keyService.ensureUserKey(row.userId);
      return 'done';
    }

    case 'reclaim_member': {
      if (!row.orgMemberId || !row.orgId) throw new Error('ORG_MEMBER_ID_REQUIRED');
      const reclaimed = await keyService.reclaimMemberKey({
        orgId: row.orgId,
        orgMemberId: row.orgMemberId,
      });
      const createdByUserId =
        typeof row.payload?.createdByUserId === 'string' ? row.payload.createdByUserId : null;
      await orgModel.reclaimMemberRemainingCredit({
        createdByUserId,
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
