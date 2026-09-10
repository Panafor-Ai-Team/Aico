import { OrganizationModel } from '@/database/models/organization';
import { aicoKeyOutbox } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import {
  type BudgetPeriod,
  cycleRemainingMicroUsd,
  hasValidManagedKeyId,
  microUsdToDecimalString,
} from '@/database/utils/aicoMoney';
import { AicoOpenRouterKeyService } from '@/server/services/openrouter/keyService';

/**
 * Bulk "reclaim every member's org-funded allowance back into the org wallet".
 *
 * Reuses the per-member primitives (`keyService.reclaimMemberKey` +
 * `OrganizationModel.reclaimMemberRemainingCredit`) rather than touching money
 * directly, so the sweep inherits their CAS idempotency and ledger semantics.
 *
 * Personal wallets (`user_wallets`) are never in scope — that money belongs to
 * the user, not the org. Only `member_budgets` allocations are swept.
 *
 * Nothing is ever rewritten: each reclaim appends one `reclaim` row to
 * `wallet_transactions`, and per-member usage history (`settledUsageMicroUsd`,
 * `usage_logs`) is left untouched.
 */

/** Where a preview row's reclaim estimate came from. */
export type SweepEstimateSource =
  /** Authoritative read from OpenRouter's `limit_remaining`. */
  | 'openrouter'
  /** No live managed key — derived from the wallet-side reservation instead. */
  | 'wallet-only'
  /** OpenRouter was unreachable; wallet-side estimate shown as a best effort. */
  | 'wallet-fallback';

export type SweepSkipReason = 'no-budget' | 'already-settled';

export interface OrgBudgetSweepPreviewRow {
  email: string | null;
  estimateSource: SweepEstimateSource;
  memberId: string;
  /** Prepaid hold for a queued period change — reclaimed in full. */
  pendingPeriodAmountMicroUsd: number;
  period: BudgetPeriod;
  /** Configured cap for the active cycle. */
  periodAmountMicroUsd: number;
  publicCode: string | null;
  reclaimMicroUsd: number;
  settledUsageMicroUsd: number;
  skipReason?: SweepSkipReason;
  username: string | null;
}

export interface OrgBudgetSweepPreview {
  currentOrgBalanceMicroUsd: number;
  memberCount: number;
  orgId: string;
  orgName: string;
  projectedOrgBalanceMicroUsd: number;
  rows: OrgBudgetSweepPreviewRow[];
  skippedCount: number;
  totalReclaimMicroUsd: number;
}

export interface OrgBudgetSweepResultRow {
  email: string | null;
  error?: string;
  memberId: string;
  publicCode: string | null;
  reclaimedMicroUsd: number;
  /**
   * `deferred` means OpenRouter could not be reached and the durable key outbox
   * owns the reclaim now — the credit lands once the worker succeeds.
   */
  status: 'reclaimed' | 'skipped' | 'deferred';
  username: string | null;
}

export interface OrgBudgetSweepResult {
  batchId: string;
  deferredCount: number;
  orgBalanceMicroUsd: number;
  orgId: string;
  reclaimedCount: number;
  rows: OrgBudgetSweepResultRow[];
  skippedCount: number;
  totalReclaimedMicroUsd: number;
}

interface SweepDeps {
  db: LobeChatDatabase;
  keyService?: AicoOpenRouterKeyService;
  orgId: string;
}

/** Members eligible for a sweep: active roster entries that own a budget row. */
const loadSweepCandidates = async (params: { model: OrganizationModel; orgId: string }) => {
  const members = await params.model.listMembersWithPublicCodes(params.orgId);
  const active = members.filter((m) => m.status === 'active');

  return Promise.all(
    active.map(async (member) => ({
      budget: await params.model.getMemberBudgetForOrg({
        orgId: params.orgId,
        orgMemberId: member.id,
      }),
      member,
    })),
  );
};

/**
 * Wallet-side remaining for a budget with no usable OpenRouter reading:
 * unspent cap for the active cycle plus any prepaid next-period hold.
 */
const walletSideRemainingMicroUsd = (budget: {
  pendingPeriodAmountMicroUsd?: number | null;
  periodAmountMicroUsd?: number | null;
  reservedMicroUsd?: number | null;
  settledUsageMicroUsd?: number | null;
}): number =>
  cycleRemainingMicroUsd(budget) + Math.max(0, Number(budget.pendingPeriodAmountMicroUsd ?? 0));

/**
 * What the sweep would reclaim, without disabling a single key.
 *
 * Read-only on purpose: a manager who opens the preview and then cancels must
 * not have left the roster unable to chat. This is why `peekMemberRemaining`
 * exists separately from `reclaimMemberKey`.
 */
export const previewOrgBudgetSweep = async ({
  db,
  keyService,
  orgId,
}: SweepDeps): Promise<OrgBudgetSweepPreview> => {
  const model = new OrganizationModel(db);
  const keys = keyService ?? new AicoOpenRouterKeyService(db);

  const org = await model.getById(orgId);
  if (!org) throw new Error('ORG_NOT_FOUND');

  const candidates = await loadSweepCandidates({ model, orgId });
  const rows: OrgBudgetSweepPreviewRow[] = [];

  for (const { budget, member } of candidates) {
    const base = {
      email: member.email,
      memberId: member.id,
      publicCode: member.publicCode,
      username: member.username,
    };

    if (!budget) {
      rows.push({
        ...base,
        estimateSource: 'wallet-only',
        pendingPeriodAmountMicroUsd: 0,
        period: 'total',
        periodAmountMicroUsd: 0,
        reclaimMicroUsd: 0,
        settledUsageMicroUsd: 0,
        skipReason: 'no-budget',
      });
      continue;
    }

    const shared = {
      ...base,
      pendingPeriodAmountMicroUsd: Math.max(0, Number(budget.pendingPeriodAmountMicroUsd ?? 0)),
      period: budget.period as BudgetPeriod,
      periodAmountMicroUsd: Number(budget.periodAmountMicroUsd ?? 0),
      settledUsageMicroUsd: Number(budget.settledUsageMicroUsd ?? 0),
    };

    // Already reclaimed: the CAS in reclaimMemberRemainingCredit would no-op.
    if (budget.renewalStatus === 'settled') {
      rows.push({
        ...shared,
        estimateSource: 'wallet-only',
        reclaimMicroUsd: 0,
        skipReason: 'already-settled',
      });
      continue;
    }

    if (!hasValidManagedKeyId(budget.openrouterKeyId)) {
      rows.push({
        ...shared,
        estimateSource: 'wallet-only',
        reclaimMicroUsd: walletSideRemainingMicroUsd(budget),
      });
      continue;
    }

    try {
      const peeked = await keys.peekMemberRemaining({ orgId, orgMemberId: member.id });
      rows.push({
        ...shared,
        estimateSource: peeked ? 'openrouter' : 'wallet-only',
        reclaimMicroUsd: peeked ? peeked.remainingMicroUsd : walletSideRemainingMicroUsd(budget),
      });
    } catch (error) {
      // A single unreachable key must not blank the whole preview — show the
      // wallet-side figure and label it, so the manager knows it is an estimate.
      console.warn('[aico] sweep preview: OpenRouter read failed for member', member.id, error);
      rows.push({
        ...shared,
        estimateSource: 'wallet-fallback',
        reclaimMicroUsd: walletSideRemainingMicroUsd(budget),
      });
    }
  }

  const totalReclaimMicroUsd = rows.reduce((sum, r) => sum + r.reclaimMicroUsd, 0);
  const currentOrgBalanceMicroUsd = Number(org.walletBalanceMicroUsd ?? 0);

  return {
    currentOrgBalanceMicroUsd,
    memberCount: rows.length,
    orgId,
    orgName: org.name,
    projectedOrgBalanceMicroUsd: currentOrgBalanceMicroUsd + totalReclaimMicroUsd,
    rows,
    skippedCount: rows.filter((r) => r.skipReason).length,
    totalReclaimMicroUsd,
  };
};

/**
 * Reclaims every member budget in the org back to the org wallet.
 *
 * Sequential on purpose: rosters are small, and serializing keeps OpenRouter
 * rate limits and the org-wallet compare-and-swap out of contention.
 *
 * Safe to re-run — each member's reclaim is guarded by a CAS on
 * `renewal_status <> 'settled'`, so a second sweep credits nothing.
 */
export const executeOrgBudgetSweep = async ({
  actorUserId,
  batchId,
  db,
  keyService,
  orgId,
}: SweepDeps & {
  /** Null for control-plane operators, who have no product user id. */
  actorUserId?: string | null;
  batchId: string;
}): Promise<OrgBudgetSweepResult> => {
  const model = new OrganizationModel(db);
  const keys = keyService ?? new AicoOpenRouterKeyService(db);

  const org = await model.getById(orgId);
  if (!org) throw new Error('ORG_NOT_FOUND');

  const candidates = await loadSweepCandidates({ model, orgId });
  const rows: OrgBudgetSweepResultRow[] = [];

  for (const { budget, member } of candidates) {
    const base = {
      email: member.email,
      memberId: member.id,
      publicCode: member.publicCode,
      username: member.username,
    };

    if (!budget || budget.renewalStatus === 'settled') {
      rows.push({ ...base, reclaimedMicroUsd: 0, status: 'skipped' });
      continue;
    }

    let remainingMicroUsd = walletSideRemainingMicroUsd(budget);

    if (hasValidManagedKeyId(budget.openrouterKeyId)) {
      try {
        const reclaimed = await keys.reclaimMemberKey({ orgId, orgMemberId: member.id });
        // `null` means the key vanished between load and call — the wallet-side
        // figure is then the only truth available, so fall through with it.
        if (reclaimed) remainingMicroUsd = reclaimed.remainingMicroUsd;
      } catch (error) {
        // Never guess an amount against a key we could not read or disable:
        // hand the whole reclaim to the durable outbox, which retries with
        // backoff and alerts on exhaustion.
        const message = error instanceof Error ? error.message : String(error);
        console.warn(
          '[aico] sweep: reclaimMemberKey failed; deferring to outbox',
          member.id,
          error,
        );
        await db.insert(aicoKeyOutbox).values({
          action: 'reclaim_member',
          nextAttemptAt: new Date(),
          openrouterKeyId: budget.openrouterKeyId,
          orgId,
          orgMemberId: member.id,
          payload: { batchId, createdByUserId: actorUserId ?? null },
          status: 'pending',
          userId: member.userId,
        });
        rows.push({ ...base, error: message, reclaimedMicroUsd: 0, status: 'deferred' });
        continue;
      }
    }

    try {
      const result = await model.reclaimMemberRemainingCredit({
        createdByUserId: actorUserId ?? null,
        description: `Sweep ${batchId}: reclaim remaining credit from member ${member.id}`,
        orgId,
        orgMemberId: member.id,
        remainingMicroUsd,
      });
      // A null transaction means the CAS lost — another sweep already settled it.
      const credited = result.transaction ? remainingMicroUsd : 0;
      rows.push({
        ...base,
        reclaimedMicroUsd: credited,
        status: result.transaction ? 'reclaimed' : 'skipped',
      });
    } catch (error) {
      // The key may already be disabled at this point, so the credit is owed but
      // unrecorded. Hand it to the outbox rather than leaving it stranded — the
      // retry re-reads the (still readable) key and settles the wallet side.
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        '[aico] sweep: reclaimMemberRemainingCredit failed; deferring',
        member.id,
        error,
      );
      await db.insert(aicoKeyOutbox).values({
        action: 'reclaim_member',
        nextAttemptAt: new Date(),
        openrouterKeyId: budget.openrouterKeyId,
        orgId,
        orgMemberId: member.id,
        payload: { batchId, createdByUserId: actorUserId ?? null },
        status: 'pending',
        userId: member.userId,
      });
      rows.push({ ...base, error: message, reclaimedMicroUsd: 0, status: 'deferred' });
    }
  }

  const fresh = await model.getById(orgId);

  return {
    batchId,
    deferredCount: rows.filter((r) => r.status === 'deferred').length,
    orgBalanceMicroUsd: Number(fresh?.walletBalanceMicroUsd ?? 0),
    orgId,
    reclaimedCount: rows.filter((r) => r.status === 'reclaimed').length,
    rows,
    skippedCount: rows.filter((r) => r.status === 'skipped').length,
    totalReclaimedMicroUsd: rows.reduce((sum, r) => sum + r.reclaimedMicroUsd, 0),
  };
};

// ─── Wire serialization ────────────────────────────────────────────────
// Money crosses the TRPC boundary as strings (micro-USD is beyond Number
// precision at scale) plus a decimal string for display, matching the rest of
// the billing procedures. Shared so the manager and control-plane panels can
// render the same table component.

export const serializeSweepPreview = (preview: OrgBudgetSweepPreview) => ({
  ...preview,
  currentOrgBalanceMicroUsd: String(preview.currentOrgBalanceMicroUsd),
  currentOrgBalanceUsd: microUsdToDecimalString(preview.currentOrgBalanceMicroUsd),
  projectedOrgBalanceMicroUsd: String(preview.projectedOrgBalanceMicroUsd),
  projectedOrgBalanceUsd: microUsdToDecimalString(preview.projectedOrgBalanceMicroUsd),
  rows: preview.rows.map((row) => ({
    ...row,
    pendingPeriodAmountMicroUsd: String(row.pendingPeriodAmountMicroUsd),
    pendingPeriodAmountUsd: microUsdToDecimalString(row.pendingPeriodAmountMicroUsd),
    periodAmountMicroUsd: String(row.periodAmountMicroUsd),
    periodAmountUsd: microUsdToDecimalString(row.periodAmountMicroUsd),
    reclaimMicroUsd: String(row.reclaimMicroUsd),
    reclaimUsd: microUsdToDecimalString(row.reclaimMicroUsd),
    settledUsageMicroUsd: String(row.settledUsageMicroUsd),
    settledUsageUsd: microUsdToDecimalString(row.settledUsageMicroUsd),
  })),
  totalReclaimMicroUsd: String(preview.totalReclaimMicroUsd),
  totalReclaimUsd: microUsdToDecimalString(preview.totalReclaimMicroUsd),
});

export const serializeSweepResult = (result: OrgBudgetSweepResult) => ({
  ...result,
  orgBalanceMicroUsd: String(result.orgBalanceMicroUsd),
  orgBalanceUsd: microUsdToDecimalString(result.orgBalanceMicroUsd),
  rows: result.rows.map((row) => ({
    ...row,
    reclaimedMicroUsd: String(row.reclaimedMicroUsd),
    reclaimedUsd: microUsdToDecimalString(row.reclaimedMicroUsd),
  })),
  totalReclaimedMicroUsd: String(result.totalReclaimedMicroUsd),
  totalReclaimedUsd: microUsdToDecimalString(result.totalReclaimedMicroUsd),
});
