import { and, asc, eq, gt, inArray, lt, lte, sql } from 'drizzle-orm';

import {
  aicoLedgerState,
  type AicoLedgerStateItem,
  memberBudgets,
  type NewAicoLedgerState,
  type UsageHoldItem,
  usageHolds,
  usageLogs,
  userWallets,
} from '../schemas/aicoOrganization';
import type { LobeChatDatabase, Transaction } from '../type';
import {
  applyMultiplierMicroUsd,
  billedUsageFromCapacity,
  currentCycleLimitMicroUsd,
  cycleRemainingMicroUsd,
} from '../utils/aicoMoney';

/**
 * Hold-and-settle usage ledger for managed traffic.
 *
 * Every managed upstream call reserves a hold *before* it is sent, with one
 * conditional UPDATE that only succeeds while the subject can still afford it.
 * Concurrent requests for the same subject queue on that row lock, so the sum
 * of their holds can never exceed what is available. When the call ends the
 * hold is settled: the actual charge moves into used, the reservation is
 * released, and one `usage_logs` row is written.
 *
 * Wallets are gated in RAW micro-USD (`raw_capacity - raw_used - raw_held`), the
 * unit a top-up bought, so no multiplier change ever revalues paid money.
 * Member budgets are gated in BILLED micro-USD like the rest of their columns.
 *
 * Lock order is always hold row → subject row, in place and in settle, so the
 * two can never deadlock each other.
 */

export const LEDGER_STATE_ID = 'default';

export type HoldSubject =
  | { type: 'wallet'; userId: string }
  | { budgetId: string; orgId: string; orgMemberId: string; type: 'budget'; userId: string };

export type HoldOperation =
  'chat' | 'embeddings' | 'image' | 'object' | 'transcribe' | 'tts' | 'video';

export type SettleReason =
  | 'estimate_aborted'
  | 'estimate_error'
  | 'estimate_no_usage'
  | 'expired'
  | 'not_metered'
  | 'released_rejected'
  | 'usage';

/** `available` is in the subject's unit: raw for a wallet, billed for a budget. */
export type HoldRefusal =
  | { available: number; reason: 'funds' }
  | { reason: 'concurrency' | 'inactive' | 'not_found' | 'renewal_blocked' };

export interface PlaceHoldParams {
  billingSource: 'organization' | 'personal';
  estInputTokens: number;
  /** Raw micro-USD; the budget hold is this with `multiplierBp` applied. */
  holdRawMicroUsd: number;
  maxOpenHolds: number;
  maxOutputTokens: number;
  modelId: string;
  modelMultiplierBp: number;
  /** Platform multiplier in force at hold time. */
  multiplierBp: number;
  operation: HoldOperation;
  pricedModelId: string | null;
  subject: HoldSubject;
  ttlSeconds: number;
}

export interface SettleTokens {
  completion: number;
  prompt: number;
  reasoning: number;
  total: number;
}

export interface SettleParams {
  /** Actual raw cost; used only when `reason === 'usage'`. */
  chargedRawMicroUsd?: number;
  rawCostMicroUsd?: number | null;
  reason: SettleReason;
  resolvedModelId?: string | null;
  tokens?: SettleTokens | null;
}

export type PlaceHoldResult = { holdId: string; ok: true } | { ok: false; refusal: HoldRefusal };

const EXPIRED_SELF_HEAL_LIMIT = 20;

const toInt = (value: unknown): number => {
  const n = Math.trunc(Number(value ?? 0));
  return Number.isFinite(n) ? n : 0;
};

const nonNegInt = (value: unknown): number => Math.max(0, toInt(value));

const intOrNull = (value: unknown): number | null =>
  value === null || value === undefined ? null : nonNegInt(value);

const settlementStatusFor = (reason: SettleReason): string => {
  if (reason === 'usage') return 'synchronized';
  if (reason === 'released_rejected' || reason === 'not_metered') return 'released';
  return 'estimated';
};

export class AicoUsageLedgerModel {
  constructor(private readonly db: LobeChatDatabase) {}

  // ─── Place ───────────────────────────────────────────────────────────

  placeHold = async (params: PlaceHoldParams): Promise<PlaceHoldResult> => {
    const holdRaw = nonNegInt(params.holdRawMicroUsd);
    const holdBilled = applyMultiplierMicroUsd(holdRaw, params.multiplierBp);
    const maxOpen = Math.max(1, toInt(params.maxOpenHolds));
    const { subject } = params;

    return this.db.transaction(async (tx) => {
      await this.settleExpiredForSubject(tx, subject);

      let budgetEpoch: number | null = null;

      if (subject.type === 'wallet') {
        const rows = await tx
          .update(userWallets)
          .set({
            openHolds: sql`${userWallets.openHolds} + 1`,
            rawHeldMicroUsd: sql`${userWallets.rawHeldMicroUsd} + ${holdRaw}`,
          })
          .where(
            and(
              eq(userWallets.userId, subject.userId),
              eq(userWallets.isActive, true),
              lt(userWallets.openHolds, maxOpen),
              sql`${userWallets.rawCapacityMicroUsd} - ${userWallets.rawUsedMicroUsd} - ${userWallets.rawHeldMicroUsd} >= ${holdRaw}`,
            ),
          )
          .returning({ id: userWallets.id });

        if (rows.length === 0) {
          return { ok: false, refusal: await this.classifyWalletRefusal(tx, subject, maxOpen) };
        }
      } else {
        const rows = await tx
          .update(memberBudgets)
          .set({
            heldMicroUsd: sql`${memberBudgets.heldMicroUsd} + ${holdBilled}`,
            openHolds: sql`${memberBudgets.openHolds} + 1`,
          })
          .where(
            and(
              eq(memberBudgets.id, subject.budgetId),
              eq(memberBudgets.orgMemberId, subject.orgMemberId),
              eq(memberBudgets.isActive, true),
              eq(memberBudgets.renewalStatus, 'active'),
              lt(memberBudgets.openHolds, maxOpen),
              sql`(CASE WHEN ${memberBudgets.periodAmountMicroUsd} > 0 THEN ${memberBudgets.periodAmountMicroUsd} ELSE ${memberBudgets.reservedMicroUsd} END) - GREATEST(${memberBudgets.settledUsageMicroUsd}, 0) - ${memberBudgets.heldMicroUsd} >= ${holdBilled}`,
            ),
          )
          .returning({ ledgerEpoch: memberBudgets.ledgerEpoch });

        if (rows.length === 0) {
          return { ok: false, refusal: await this.classifyBudgetRefusal(tx, subject, maxOpen) };
        }
        budgetEpoch = rows[0].ledgerEpoch;
      }

      const [hold] = await tx
        .insert(usageHolds)
        .values({
          ...this.holdRowValues(params, holdRaw, holdBilled),
          budgetEpoch,
          mode: 'enforce',
        })
        .returning({ id: usageHolds.id });

      return { holdId: hold.id, ok: true };
    });
  };

  /**
   * Records what enforce would have done without touching the subject. Shadow
   * holds are settled like real ones so their actual/hold ratio can be measured.
   */
  recordShadowHold = async (
    params: PlaceHoldParams & { refuseReason: string | null; wouldRefuse: boolean },
  ): Promise<string> => {
    const holdRaw = nonNegInt(params.holdRawMicroUsd);
    const holdBilled = applyMultiplierMicroUsd(holdRaw, params.multiplierBp);
    const [hold] = await this.db
      .insert(usageHolds)
      .values({
        ...this.holdRowValues(params, holdRaw, holdBilled),
        mode: 'shadow',
        refuseReason: params.refuseReason,
        wouldRefuse: params.wouldRefuse,
      })
      .returning({ id: usageHolds.id });
    return hold.id;
  };

  /**
   * Approximate refusal enforce would give, from legacy figures. Ledger columns
   * are not maintained outside enforce, so this uses `settled_usage` instead.
   */
  shadowAvailability = async (params: {
    holdBilledMicroUsd: number;
    maxOpenHolds: number;
    subject: HoldSubject;
  }): Promise<HoldRefusal | null> => {
    const { subject } = params;
    const holdBilled = nonNegInt(params.holdBilledMicroUsd);
    const maxOpen = Math.max(1, toInt(params.maxOpenHolds));

    if (subject.type === 'wallet') {
      const wallet = await this.db.query.userWallets.findFirst({
        where: eq(userWallets.userId, subject.userId),
      });
      if (!wallet) return { reason: 'not_found' };
      if (!wallet.isActive) return { reason: 'inactive' };
      const open = await this.countOpenShadowHolds(
        and(eq(usageHolds.userId, subject.userId), eq(usageHolds.subjectType, 'wallet')),
      );
      if (open >= maxOpen) return { reason: 'concurrency' };
      const available =
        toInt(wallet.balanceMicroUsd) - Math.max(0, toInt(wallet.settledUsageMicroUsd));
      if (available < holdBilled) return { available: Math.max(0, available), reason: 'funds' };
      return null;
    }

    const budget = await this.db.query.memberBudgets.findFirst({
      where: and(
        eq(memberBudgets.id, subject.budgetId),
        eq(memberBudgets.orgMemberId, subject.orgMemberId),
      ),
    });
    if (!budget) return { reason: 'not_found' };
    if (!budget.isActive) return { reason: 'inactive' };
    if (budget.renewalStatus !== 'active') return { reason: 'renewal_blocked' };
    const open = await this.countOpenShadowHolds(eq(usageHolds.budgetId, subject.budgetId));
    if (open >= maxOpen) return { reason: 'concurrency' };
    const available = cycleRemainingMicroUsd(budget);
    if (available < holdBilled) return { available, reason: 'funds' };
    return null;
  };

  // ─── Settle ──────────────────────────────────────────────────────────

  /** Idempotent: a hold that is no longer open is left untouched. */
  settleHold = async (holdId: string, params: SettleParams): Promise<{ settled: boolean }> =>
    this.db.transaction(async (tx) => this.settleInTx(tx, holdId, params));

  /**
   * Charges every open hold past its deadline in full (both modes). Each hold
   * settles in its own transaction so one failure cannot stall the batch.
   */
  expireHolds = async (params: { limit: number }): Promise<number> => {
    const due = await this.db
      .select({ id: usageHolds.id })
      .from(usageHolds)
      .where(and(eq(usageHolds.status, 'open'), lt(usageHolds.expiresAt, sql`now()`)))
      .orderBy(asc(usageHolds.expiresAt))
      .limit(Math.max(1, toInt(params.limit)));

    let expired = 0;
    for (const { id } of due) {
      const { settled } = await this.settleHold(id, { reason: 'expired' });
      if (settled) expired += 1;
    }
    return expired;
  };

  // ─── Aggregates ──────────────────────────────────────────────────────

  aggregateOpenHoldsRaw = async (): Promise<number> => {
    const [row] = await this.db
      .select({ total: sql<string>`COALESCE(SUM(${usageHolds.holdRawMicroUsd}), 0)` })
      .from(usageHolds)
      .where(and(eq(usageHolds.mode, 'enforce'), eq(usageHolds.status, 'open')));
    return toInt(row?.total);
  };

  /** Raw charged by enforce holds settled in `(from, to]`. */
  sumChargedRaw = async (params: { from: Date; to: Date }): Promise<number> => {
    const [row] = await this.db
      .select({ total: sql<string>`COALESCE(SUM(${usageHolds.chargedRawMicroUsd}), 0)` })
      .from(usageHolds)
      .where(
        and(
          eq(usageHolds.mode, 'enforce'),
          inArray(usageHolds.status, ['settled', 'expired']),
          gt(usageHolds.settledAt, params.from),
          lte(usageHolds.settledAt, params.to),
        ),
      );
    return toInt(row?.total);
  };

  countOpenEnforceHolds = async (): Promise<number> => {
    const [row] = await this.db
      .select({ count: sql<string>`COUNT(*)` })
      .from(usageHolds)
      .where(and(eq(usageHolds.mode, 'enforce'), eq(usageHolds.status, 'open')));
    return toInt(row?.count);
  };

  // ─── State ───────────────────────────────────────────────────────────

  getState = async (): Promise<AicoLedgerStateItem> => {
    const existing = await this.db.query.aicoLedgerState.findFirst({
      where: eq(aicoLedgerState.id, LEDGER_STATE_ID),
    });
    if (existing) return existing;

    // The migration seeds this row; recreate it rather than fail if it was lost.
    await this.db.insert(aicoLedgerState).values({ id: LEDGER_STATE_ID }).onConflictDoNothing();
    const created = await this.db.query.aicoLedgerState.findFirst({
      where: eq(aicoLedgerState.id, LEDGER_STATE_ID),
    });
    if (!created) throw new Error('LEDGER_STATE_MISSING');
    return created;
  };

  updateState = async (patch: Partial<Omit<NewAicoLedgerState, 'id'>>): Promise<void> => {
    await this.getState();
    await this.db
      .update(aicoLedgerState)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(aicoLedgerState.id, LEDGER_STATE_ID));
  };

  /** Cross-process single flight for the float refresh: at most one claim per 30s. */
  claimFloatRefresh = async (): Promise<boolean> => {
    await this.getState();
    const rows = await this.db
      .update(aicoLedgerState)
      .set({ floatRefreshClaimedAt: sql`now()` })
      .where(
        and(
          eq(aicoLedgerState.id, LEDGER_STATE_ID),
          sql`(${aicoLedgerState.floatRefreshClaimedAt} IS NULL OR ${aicoLedgerState.floatRefreshClaimedAt} < now() - interval '30 seconds')`,
        ),
      )
      .returning({ id: aicoLedgerState.id });
    return rows.length > 0;
  };

  // ─── Internals ───────────────────────────────────────────────────────

  private holdRowValues = (params: PlaceHoldParams, holdRaw: number, holdBilled: number) => {
    const { subject } = params;
    return {
      billingSource: params.billingSource,
      budgetId: subject.type === 'budget' ? subject.budgetId : null,
      estInputTokens: nonNegInt(params.estInputTokens),
      expiresAt: sql`now() + make_interval(secs => ${Math.max(1, toInt(params.ttlSeconds))})`,
      holdMicroUsd: holdBilled,
      holdRawMicroUsd: holdRaw,
      maxOutputTokens: nonNegInt(params.maxOutputTokens),
      modelId: params.modelId,
      modelMultiplierBp: toInt(params.modelMultiplierBp) || 10_000,
      multiplierBp: toInt(params.multiplierBp),
      operation: params.operation,
      orgId: subject.type === 'budget' ? subject.orgId : null,
      orgMemberId: subject.type === 'budget' ? subject.orgMemberId : null,
      pricedModelId: params.pricedModelId,
      subjectType: subject.type,
      unit: subject.type === 'wallet' ? 'raw' : 'billed',
      userId: subject.userId,
    } as const;
  };

  private countOpenShadowHolds = async (where: ReturnType<typeof and>): Promise<number> => {
    const [row] = await this.db
      .select({ count: sql<string>`COUNT(*)` })
      .from(usageHolds)
      .where(and(eq(usageHolds.mode, 'shadow'), eq(usageHolds.status, 'open'), where));
    return toInt(row?.count);
  };

  /**
   * Settles this subject's own overdue enforce holds before placing a new one,
   * so a crashed process cannot keep a subject's balance reserved until the
   * maintenance cron runs.
   */
  private settleExpiredForSubject = async (tx: Transaction, subject: HoldSubject) => {
    const subjectFilter =
      subject.type === 'wallet'
        ? and(eq(usageHolds.userId, subject.userId), eq(usageHolds.subjectType, 'wallet'))
        : eq(usageHolds.budgetId, subject.budgetId);

    const expired = await tx
      .select({ id: usageHolds.id })
      .from(usageHolds)
      .where(
        and(
          eq(usageHolds.mode, 'enforce'),
          eq(usageHolds.status, 'open'),
          lt(usageHolds.expiresAt, sql`now()`),
          subjectFilter,
        ),
      )
      .limit(EXPIRED_SELF_HEAL_LIMIT)
      .for('update', { skipLocked: true });

    for (const { id } of expired) {
      await this.settleInTx(tx, id, { reason: 'expired' });
    }
  };

  private classifyWalletRefusal = async (
    tx: Transaction,
    subject: Extract<HoldSubject, { type: 'wallet' }>,
    maxOpen: number,
  ): Promise<HoldRefusal> => {
    const [wallet] = await tx
      .select()
      .from(userWallets)
      .where(eq(userWallets.userId, subject.userId))
      .limit(1);
    if (!wallet) return { reason: 'not_found' };
    if (!wallet.isActive) return { reason: 'inactive' };
    if (toInt(wallet.openHolds) >= maxOpen) return { reason: 'concurrency' };
    const available =
      toInt(wallet.rawCapacityMicroUsd) -
      toInt(wallet.rawUsedMicroUsd) -
      toInt(wallet.rawHeldMicroUsd);
    return { available: Math.max(0, available), reason: 'funds' };
  };

  private classifyBudgetRefusal = async (
    tx: Transaction,
    subject: Extract<HoldSubject, { type: 'budget' }>,
    maxOpen: number,
  ): Promise<HoldRefusal> => {
    const [budget] = await tx
      .select()
      .from(memberBudgets)
      .where(
        and(
          eq(memberBudgets.id, subject.budgetId),
          eq(memberBudgets.orgMemberId, subject.orgMemberId),
        ),
      )
      .limit(1);
    if (!budget) return { reason: 'not_found' };
    if (!budget.isActive) return { reason: 'inactive' };
    if (budget.renewalStatus !== 'active') return { reason: 'renewal_blocked' };
    if (toInt(budget.openHolds) >= maxOpen) return { reason: 'concurrency' };
    const available =
      currentCycleLimitMicroUsd(budget) -
      Math.max(0, toInt(budget.settledUsageMicroUsd)) -
      toInt(budget.heldMicroUsd);
    return { available: Math.max(0, available), reason: 'funds' };
  };

  private chargedRawFor = (hold: UsageHoldItem, params: SettleParams): number => {
    switch (params.reason) {
      case 'usage': {
        // A usage settle without a figure is charged the hold, never zero.
        return params.chargedRawMicroUsd === undefined
          ? nonNegInt(hold.holdRawMicroUsd)
          : nonNegInt(params.chargedRawMicroUsd);
      }
      case 'released_rejected':
      case 'not_metered': {
        return 0;
      }
      default: {
        return nonNegInt(hold.holdRawMicroUsd);
      }
    }
  };

  private settleInTx = async (
    tx: Transaction,
    holdId: string,
    params: SettleParams,
  ): Promise<{ settled: boolean }> => {
    const [hold] = await tx
      .select()
      .from(usageHolds)
      .where(and(eq(usageHolds.id, holdId), eq(usageHolds.status, 'open')))
      .limit(1)
      .for('update');
    if (!hold) return { settled: false };

    const chargedRaw = this.chargedRawFor(hold, params);
    const chargedBilled = applyMultiplierMicroUsd(chargedRaw, hold.multiplierBp);
    const tokens = params.tokens ?? null;

    await tx
      .update(usageHolds)
      .set({
        chargedMicroUsd: chargedBilled,
        chargedRawMicroUsd: chargedRaw,
        completionTokens: intOrNull(tokens?.completion),
        promptTokens: intOrNull(tokens?.prompt),
        rawCostMicroUsd: intOrNull(params.rawCostMicroUsd),
        reasoningTokens: intOrNull(tokens?.reasoning),
        resolvedModelId: params.resolvedModelId ?? null,
        settleReason: params.reason,
        settledAt: sql`now()`,
        status: params.reason === 'expired' ? 'expired' : 'settled',
        totalTokens: intOrNull(tokens?.total),
      })
      .where(eq(usageHolds.id, hold.id));

    if (hold.mode !== 'enforce') return { settled: true };

    if (hold.subjectType === 'wallet') {
      const [wallet] = await tx
        .update(userWallets)
        .set({
          openHolds: sql`GREATEST(0, ${userWallets.openHolds} - 1)`,
          rawHeldMicroUsd: sql`GREATEST(0, ${userWallets.rawHeldMicroUsd} - ${nonNegInt(hold.holdRawMicroUsd)})`,
          rawUsedMicroUsd: sql`${userWallets.rawUsedMicroUsd} + ${chargedRaw}`,
        })
        .where(eq(userWallets.userId, hold.userId))
        .returning({
          balanceMicroUsd: userWallets.balanceMicroUsd,
          rawCapacityMicroUsd: userWallets.rawCapacityMicroUsd,
          rawUsedMicroUsd: userWallets.rawUsedMicroUsd,
        });

      if (wallet) {
        // Keep the figure the wallet UI already reads in step with the ledger.
        await tx
          .update(userWallets)
          .set({
            lastSyncError: null,
            lastSyncStatus: 'synced',
            lastSyncedAt: new Date(),
            settledUsageMicroUsd: billedUsageFromCapacity({
              balanceMicroUsd: wallet.balanceMicroUsd,
              fallbackBp: hold.multiplierBp,
              rawCapacityMicroUsd: wallet.rawCapacityMicroUsd,
              rawUsageMicroUsd: wallet.rawUsedMicroUsd,
            }),
          })
          .where(eq(userWallets.userId, hold.userId));
      }
    } else if (hold.budgetId) {
      await tx
        .update(memberBudgets)
        .set({
          heldMicroUsd: sql`GREATEST(0, ${memberBudgets.heldMicroUsd} - ${nonNegInt(hold.holdMicroUsd)})`,
          lastSyncStatus: 'synced',
          lastSyncedAt: new Date(),
          openHolds: sql`GREATEST(0, ${memberBudgets.openHolds} - 1)`,
          // A hold placed before a renewal must not charge the new cycle: the
          // renewal already refunded the old cycle net of this hold.
          settledUsageMicroUsd: sql`CASE WHEN ${memberBudgets.ledgerEpoch} = ${toInt(hold.budgetEpoch)} THEN ${memberBudgets.settledUsageMicroUsd} + ${chargedBilled} ELSE ${memberBudgets.settledUsageMicroUsd} END`,
        })
        .where(eq(memberBudgets.id, hold.budgetId));
    }

    await tx
      .insert(usageLogs)
      .values({
        billingSource: hold.billingSource,
        completionTokens: nonNegInt(tokens?.completion),
        costMicroUsd: chargedBilled,
        holdId: hold.id,
        modelId: params.resolvedModelId ?? hold.modelId,
        multiplierBp: hold.multiplierBp,
        orgId: hold.orgId,
        orgMemberId: hold.orgMemberId,
        promptTokens: nonNegInt(tokens?.prompt),
        settlementStatus: settlementStatusFor(params.reason),
        totalTokens: nonNegInt(tokens?.total),
        userId: hold.userId,
      })
      .onConflictDoNothing({ target: usageLogs.holdId });

    return { settled: true };
  };
}
