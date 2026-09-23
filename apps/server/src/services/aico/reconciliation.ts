/**
 * Books-balance checks for managed billing.
 *
 * Every pass answers one question per check — do the books still add up? — and
 * stores the verdicts in `aico_reconciliation_runs` for the admin panel. It runs
 * on a cron and on an admin's "Run now", and it is strictly read-only: it never
 * edits a key (a CVC same-state edit is only a read while the state is known,
 * and a wrong guess would freeze or unfreeze a live key), never moves money.
 *
 * Checks:
 * - `wallet_ledger`: each wallet's transactions sum to its balance, and every
 *   row's `balance_before` is the previous row's `balance_after`.
 * - `org_ledger`: the same chain for organization wallets.
 * - `ledger_actor`: every money movement names who made it and why.
 * - `float_liability`: what live keys can still spend vs the CVC float.
 * - `key_drift`: per subject, what its key can still spend vs what it has left.
 * - `key_hygiene`: keys on the wrong gateway, stuck renewals, failing outbox
 *   jobs, holds past their deadline.
 * - `usage_coverage`: settled holds without a priced `usage_logs` row.
 * - `openrouter_orphans`: enabled OpenRouter keys no row points at.
 */
import type { LobeChatDatabase } from '@lobechat/database';
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';

import { AicoBillingModel } from '@/database/models/aicoBilling';
import {
  aicoKeyOutbox,
  type AicoReconciliationCheck,
  type AicoReconciliationRunItem,
  aicoReconciliationRuns,
  type AicoReconciliationStatus,
  memberBudgets,
  organizations,
  usageHolds,
  usageLogs,
  userWallets,
  walletTransactions,
} from '@/database/schemas';
import { cycleRemainingMicroUsd } from '@/database/utils/aicoMoney';
import { aicoEnv } from '@/envs/aico';
import {
  getManagedProviderClient,
  type ManagedProviderClient,
} from '@/server/services/managedProvider';
import { AicoOpenRouterKeyService } from '@/server/services/openrouter/keyService';

/** Liability at or above this share of the float is a warning. */
export const FLOAT_WARN_RATIO = 0.8;
/** A key/subject mismatch smaller than this is rounding, not drift. */
const DRIFT_TOLERANCE_MICRO = 10_000;
const MAX_DETAILS = 50;
/** `/v1/balance` is rate limited; space key reads out (see cheapvibecode.ts). */
const KEY_READ_SPACING_MS = 1200;
/** Manual runs closer together than this return the latest run instead. */
export const MANUAL_RUN_COOLDOWN_MS = 60_000;

/**
 * Transactions that the platform writes on its own schedule, with no human
 * actor to record.
 */
const SYSTEM_TX_TYPES = new Set([
  'period_refund',
  'period_renewal',
  'period_reservation',
  'period_settlement',
  'reclaim',
  'renewal_failure',
]);

const RANK: Record<AicoReconciliationStatus, number> = { critical: 3, error: 2, ok: 0, warn: 1 };

export const worstStatus = (statuses: AicoReconciliationStatus[]): AicoReconciliationStatus =>
  statuses.reduce<AicoReconciliationStatus>(
    (worst, s) => (RANK[s] > RANK[worst] ? s : worst),
    'ok',
  );

const usd = (micro: number) => `$${(micro / 1_000_000).toFixed(4)}`;

const check = (
  id: string,
  details: string[],
  values: AicoReconciliationCheck['values'],
  status: AicoReconciliationStatus,
): AicoReconciliationCheck => ({
  details: details.slice(0, MAX_DETAILS),
  id,
  status,
  values: { ...values, issues: details.length },
});

export interface ReconciliationDeps {
  /** Enabled OpenRouter keys; `null` when no management key is configured. */
  listOpenRouterKeys?: () => Promise<{ hash: string; name: string }[] | null>;
  managed?: ManagedProviderClient;
  /** Test seam for the key-read spacing. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultListOpenRouterKeys = async () => {
  const apiKey = aicoEnv.OPENROUTER_MANAGEMENT_API_KEY;
  if (!apiKey) return null;
  const res = await fetch('https://openrouter.ai/api/v1/keys', {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`OpenRouter Management API ${res.status}`);
  const json = (await res.json()) as {
    data?: { disabled?: boolean; hash?: string; name?: string }[];
  };
  return (json.data ?? [])
    .filter((k) => !k.disabled && k.hash)
    .map((k) => ({ hash: k.hash as string, name: k.name ?? '' }));
};

// ─── Ledger chains ────────────────────────────────────────────────────────

interface ChainRow {
  amountMicroUsd: number | null;
  balanceAfterMicroUsd: number | null;
  balanceBeforeMicroUsd: number | null;
  createdAt: Date;
  id: string;
}

/**
 * Oldest first, with rows written at the same instant (one database
 * transaction, e.g. a period refund and the renewal that follows it) put in
 * the order that continues the chain. Their ids are random, so sorting ties by
 * id would report a break that never happened.
 */
export const orderChain = <T extends ChainRow>(rows: T[]): T[] => {
  const sorted = [...rows].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
  );
  const out: T[] = [];
  let prevAfter: number | null = null;
  for (let i = 0; i < sorted.length;) {
    let j = i;
    while (j < sorted.length && sorted[j].createdAt.getTime() === sorted[i].createdAt.getTime())
      j++;
    const group = sorted.slice(i, j);
    while (group.length > 0) {
      const next = group.findIndex(
        (r) =>
          prevAfter != null &&
          r.balanceBeforeMicroUsd != null &&
          Number(r.balanceBeforeMicroUsd) === prevAfter,
      );
      const [row] = group.splice(Math.max(next, 0), 1);
      out.push(row);
      if (row.balanceAfterMicroUsd != null) prevAfter = Number(row.balanceAfterMicroUsd);
    }
    i = j;
  }
  return out;
};

/** Chain breaks within one subject's rows, oldest first. */
const chainBreaks = (label: string, rows: ChainRow[]): string[] => {
  const out: string[] = [];
  let prevAfter: number | null = null;
  for (const row of rows) {
    const before = row.balanceBeforeMicroUsd == null ? null : Number(row.balanceBeforeMicroUsd);
    const after = row.balanceAfterMicroUsd == null ? null : Number(row.balanceAfterMicroUsd);
    if (before != null && prevAfter != null && before !== prevAfter) {
      out.push(
        `${label}: ${row.id} starts at ${usd(before)}, previous row ended at ${usd(prevAfter)}`,
      );
    }
    if (before != null && after != null && after - before !== Number(row.amountMicroUsd ?? 0)) {
      out.push(
        `${label}: ${row.id} moves ${usd(after - before)} but records ${usd(Number(row.amountMicroUsd ?? 0))}`,
      );
    }
    if (after != null) prevAfter = after;
  }
  return out;
};

const walletLedgerCheck = async (db: LobeChatDatabase): Promise<AicoReconciliationCheck> => {
  const wallets = await db
    .select({ balance: userWallets.balanceMicroUsd, userId: userWallets.userId })
    .from(userWallets);
  const rows = await db
    .select({
      amountMicroUsd: walletTransactions.amountMicroUsd,
      balanceAfterMicroUsd: walletTransactions.balanceAfterMicroUsd,
      balanceBeforeMicroUsd: walletTransactions.balanceBeforeMicroUsd,
      createdAt: walletTransactions.createdAt,
      id: walletTransactions.id,
      userId: walletTransactions.userId,
    })
    .from(walletTransactions)
    .where(and(isNull(walletTransactions.orgId), isNotNull(walletTransactions.userId)))
    .orderBy(asc(walletTransactions.createdAt), asc(walletTransactions.id));

  const byUser = new Map<string, ChainRow[]>();
  for (const row of rows) {
    const list = byUser.get(row.userId!) ?? [];
    list.push(row);
    byUser.set(row.userId!, list);
  }

  const details: string[] = [];
  let unexplainedMicro = 0;
  for (const wallet of wallets) {
    const list = orderChain(byUser.get(wallet.userId) ?? []);
    const sum = list.reduce((acc, r) => acc + Number(r.amountMicroUsd ?? 0), 0);
    const balance = Number(wallet.balance ?? 0);
    if (sum !== balance) {
      unexplainedMicro += Math.abs(balance - sum);
      details.push(
        `wallet ${wallet.userId}: balance ${usd(balance)} but its transactions sum to ${usd(sum)}`,
      );
    }
    details.push(...chainBreaks(`wallet ${wallet.userId}`, list));
  }

  return check(
    'wallet_ledger',
    details,
    { unexplainedMicroUsd: unexplainedMicro, wallets: wallets.length },
    details.length > 0 ? 'critical' : 'ok',
  );
};

const orgLedgerCheck = async (db: LobeChatDatabase): Promise<AicoReconciliationCheck> => {
  const orgs = await db
    .select({ balance: organizations.walletBalanceMicroUsd, id: organizations.id })
    .from(organizations);
  const rows = await db
    .select({
      amountMicroUsd: walletTransactions.amountMicroUsd,
      balanceAfterMicroUsd: walletTransactions.balanceAfterMicroUsd,
      balanceBeforeMicroUsd: walletTransactions.balanceBeforeMicroUsd,
      createdAt: walletTransactions.createdAt,
      id: walletTransactions.id,
      orgId: walletTransactions.orgId,
    })
    .from(walletTransactions)
    .where(
      and(isNotNull(walletTransactions.orgId), isNotNull(walletTransactions.balanceAfterMicroUsd)),
    )
    .orderBy(asc(walletTransactions.createdAt), asc(walletTransactions.id));

  const byOrg = new Map<string, ChainRow[]>();
  for (const row of rows) {
    const list = byOrg.get(row.orgId!) ?? [];
    list.push(row);
    byOrg.set(row.orgId!, list);
  }

  const details: string[] = [];
  for (const org of orgs) {
    const list = orderChain(byOrg.get(org.id) ?? []);
    // Org rows record the org wallet's before/after, but the amount's sign is
    // the member's point of view (an allocation is positive and drains the
    // org), so only the chain and its end point are checked here.
    const last = list.at(-1);
    const balance = Number(org.balance ?? 0);
    if (last && Number(last.balanceAfterMicroUsd) !== balance) {
      details.push(
        `org ${org.id}: balance ${usd(balance)} but its last transaction ended at ${usd(Number(last.balanceAfterMicroUsd))}`,
      );
    }
    let prevAfter: number | null = null;
    for (const row of list) {
      const before = row.balanceBeforeMicroUsd == null ? null : Number(row.balanceBeforeMicroUsd);
      if (before != null && prevAfter != null && before !== prevAfter) {
        details.push(
          `org ${org.id}: ${row.id} starts at ${usd(before)}, previous row ended at ${usd(prevAfter)}`,
        );
      }
      prevAfter = Number(row.balanceAfterMicroUsd);
    }
  }

  return check(
    'org_ledger',
    details,
    { orgs: orgs.length },
    details.length > 0 ? 'critical' : 'ok',
  );
};

const ledgerActorCheck = async (db: LobeChatDatabase): Promise<AicoReconciliationCheck> => {
  const rows = await db
    .select({
      adminId: walletTransactions.createdByAdminId,
      description: walletTransactions.description,
      id: walletTransactions.id,
      type: walletTransactions.type,
      userId: walletTransactions.createdByUserId,
    })
    .from(walletTransactions);

  const details: string[] = [];
  for (const row of rows) {
    if (SYSTEM_TX_TYPES.has(row.type)) continue;
    if (!row.adminId && !row.userId) details.push(`${row.type} ${row.id}: no actor recorded`);
    else if (!row.description?.trim()) details.push(`${row.type} ${row.id}: no reason recorded`);
  }
  return check(
    'ledger_actor',
    details,
    { transactions: rows.length },
    details.length > 0 ? 'warn' : 'ok',
  );
};

// ─── Keys against the gateway ─────────────────────────────────────────────

interface KeyExposure {
  /** Billed micro-USD the subject may still spend by our books. */
  availableBilledMicro: number;
  /** Billed per raw, as a ratio, for comparing the key to the books. */
  billedPerRaw: number;
  label: string;
  row: {
    managedKeyLimitMicroUsd: number | null;
    openrouterKeyCiphertext: string | null;
    openrouterKeyId: string;
  };
}

const keyChecks = async (
  db: LobeChatDatabase,
  deps: ReconciliationDeps,
): Promise<AicoReconciliationCheck[]> => {
  const managed = deps.managed ?? getManagedProviderClient();
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const keyService = new AicoOpenRouterKeyService(db, managed);
  const bp = await new AicoBillingModel(db).getUsageMultiplierBp();

  const subjects: KeyExposure[] = [];
  const wallets = await db
    .select()
    .from(userWallets)
    .where(
      and(
        eq(userWallets.managedKeyProviderId, managed.providerId),
        isNotNull(userWallets.openrouterKeyCiphertext),
      ),
    );
  for (const w of wallets) {
    const balance = Number(w.balanceMicroUsd ?? 0);
    const rawCap = Number(w.rawCapacityMicroUsd ?? 0);
    subjects.push({
      availableBilledMicro: Math.max(0, balance - Math.max(0, Number(w.settledUsageMicroUsd ?? 0))),
      billedPerRaw: rawCap > 0 ? balance / rawCap : bp / 10_000,
      label: `wallet ${w.userId}`,
      row: {
        managedKeyLimitMicroUsd: w.managedKeyLimitMicroUsd,
        openrouterKeyCiphertext: w.openrouterKeyCiphertext,
        openrouterKeyId: w.openrouterKeyId!,
      },
    });
  }
  const budgets = await db
    .select()
    .from(memberBudgets)
    .where(
      and(
        eq(memberBudgets.managedKeyProviderId, managed.providerId),
        isNotNull(memberBudgets.openrouterKeyCiphertext),
      ),
    );
  for (const b of budgets) {
    const spendable = b.isActive && b.renewalStatus === 'active';
    subjects.push({
      availableBilledMicro: spendable ? cycleRemainingMicroUsd(b) : 0,
      billedPerRaw: bp / 10_000,
      label: `budget ${b.id} (${b.orgMemberId})`,
      row: {
        managedKeyLimitMicroUsd: b.managedKeyLimitMicroUsd,
        openrouterKeyCiphertext: b.openrouterKeyCiphertext,
        openrouterKeyId: b.openrouterKeyId!,
      },
    });
  }

  let exposureRawMicro = 0;
  let promisedBilledMicro = 0;
  const drift: string[] = [];
  let driftStatus: AicoReconciliationStatus = 'ok';
  let unreadable = 0;

  for (const [i, subject] of subjects.entries()) {
    promisedBilledMicro += subject.availableBilledMicro;
    if (i > 0) await sleep(KEY_READ_SPACING_MS);
    let remainingRawMicro: number;
    try {
      const apiKey = subject.row.openrouterKeyCiphertext
        ? await keyService.decryptKey(subject.row.openrouterKeyCiphertext)
        : null;
      const info = await managed.getKey({
        apiKey: apiKey ?? undefined,
        hash: subject.row.openrouterKeyId,
      });
      if (info.limitRemaining == null) throw new Error('no remaining reported');
      remainingRawMicro = Math.round(info.limitRemaining * 1_000_000);
    } catch (error) {
      // A frozen key answers 401 — it cannot spend, so it adds no exposure. Any
      // key that *should* be spendable but cannot be read is worth a look.
      if (subject.availableBilledMicro > 0) {
        unreadable += 1;
        drift.push(
          `${subject.label}: key ${subject.row.openrouterKeyId.slice(0, 8)} unreadable (${(error as Error).message.slice(0, 60)})`,
        );
        driftStatus = worstStatus([driftStatus, 'warn']);
      }
      continue;
    }

    exposureRawMicro += remainingRawMicro;
    const keyBilledMicro = Math.round(remainingRawMicro * subject.billedPerRaw);
    const gap = keyBilledMicro - subject.availableBilledMicro;
    const tolerance = Math.max(DRIFT_TOLERANCE_MICRO, subject.availableBilledMicro * 0.01);
    if (gap > tolerance) {
      drift.push(
        `${subject.label}: key can spend ${usd(keyBilledMicro)} but only ${usd(subject.availableBilledMicro)} is left — over-granted by ${usd(gap)}`,
      );
      driftStatus = worstStatus([driftStatus, 'critical']);
    } else if (-gap > tolerance) {
      drift.push(
        `${subject.label}: key can spend ${usd(keyBilledMicro)} of the ${usd(subject.availableBilledMicro)} left — under by ${usd(-gap)}`,
      );
      driftStatus = worstStatus([driftStatus, 'warn']);
    }
  }

  const driftCheck = check('key_drift', drift, { keys: subjects.length, unreadable }, driftStatus);

  let floatCheck: AicoReconciliationCheck;
  try {
    const floatRawMicro = Math.round((await managed.getAccountBalanceUsd()) * 1_000_000);
    const ratio =
      floatRawMicro > 0 ? exposureRawMicro / floatRawMicro : exposureRawMicro > 0 ? Infinity : 0;
    const status: AicoReconciliationStatus =
      ratio > 1 ? 'critical' : ratio >= FLOAT_WARN_RATIO ? 'warn' : 'ok';
    const details =
      status === 'ok'
        ? []
        : [
            `live keys can spend ${usd(exposureRawMicro)} against a float of ${usd(floatRawMicro)} (${Number.isFinite(ratio) ? Math.round(ratio * 100) : '∞'}%)`,
          ];
    floatCheck = check(
      'float_liability',
      details,
      {
        exposureRawMicroUsd: exposureRawMicro,
        floatRawMicroUsd: floatRawMicro,
        promisedBilledMicroUsd: promisedBilledMicro,
        ratioPercent: Number.isFinite(ratio) ? Math.round(ratio * 1000) / 10 : null,
      },
      status,
    );
  } catch (error) {
    floatCheck = check(
      'float_liability',
      [`float unreadable: ${(error as Error).message.slice(0, 80)}`],
      {
        exposureRawMicroUsd: exposureRawMicro,
        floatRawMicroUsd: null,
        promisedBilledMicroUsd: promisedBilledMicro,
      },
      'error',
    );
  }

  return [floatCheck, driftCheck];
};

const keyHygieneCheck = async (
  db: LobeChatDatabase,
  activeProvider: string,
): Promise<AicoReconciliationCheck> => {
  const details: string[] = [];
  const now = new Date();

  const staleWallets = await db
    .select({ id: userWallets.userId, provider: userWallets.managedKeyProviderId })
    .from(userWallets)
    .where(
      and(
        isNotNull(userWallets.openrouterKeyId),
        sql`COALESCE(${userWallets.managedKeyProviderId}, 'openrouter') <> ${activeProvider}`,
        sql`${userWallets.balanceMicroUsd} > ${userWallets.settledUsageMicroUsd}`,
      ),
    );
  for (const w of staleWallets) {
    details.push(`wallet ${w.id}: funded but its key is on ${w.provider ?? 'openrouter'}`);
  }

  // A failed batch switches its budgets off (`failBatch`), so a failed renewal
  // is looked for whatever the budget's active flag says.
  const budgets = await db
    .select({
      id: memberBudgets.id,
      isActive: memberBudgets.isActive,
      provider: memberBudgets.managedKeyProviderId,
      renewalStatus: memberBudgets.renewalStatus,
    })
    .from(memberBudgets)
    .where(or(eq(memberBudgets.isActive, true), eq(memberBudgets.renewalStatus, 'renewal_failed')));
  for (const b of budgets) {
    if (b.renewalStatus === 'renewal_failed') {
      details.push(
        b.isActive
          ? `budget ${b.id}: renewal failed`
          : `budget ${b.id}: renewal failed and the budget is off`,
      );
    }
    if (
      b.isActive &&
      b.renewalStatus === 'active' &&
      (b.provider ?? 'openrouter') !== activeProvider
    ) {
      details.push(`budget ${b.id}: active but its key is on ${b.provider ?? 'openrouter'}`);
    }
  }

  const failingJobs = await db
    .select({
      action: aicoKeyOutbox.action,
      attempts: aicoKeyOutbox.attempts,
      id: aicoKeyOutbox.id,
    })
    .from(aicoKeyOutbox)
    .where(
      sql`${aicoKeyOutbox.status} = 'failed' OR (${aicoKeyOutbox.status} = 'pending' AND ${aicoKeyOutbox.attempts} >= 3)`,
    );
  for (const job of failingJobs) {
    details.push(`outbox ${job.id}: ${job.action} still failing after ${job.attempts} attempts`);
  }

  const [overdue] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(usageHolds)
    .where(
      and(
        eq(usageHolds.status, 'open'),
        lt(usageHolds.expiresAt, new Date(now.getTime() - 10 * 60_000)),
      ),
    );
  if (Number(overdue?.n ?? 0) > 0) {
    details.push(`${overdue!.n} open hold(s) more than 10 minutes past their deadline`);
  }

  return check('key_hygiene', details, {}, details.length > 0 ? 'warn' : 'ok');
};

const usageCoverageCheck = async (db: LobeChatDatabase): Promise<AicoReconciliationCheck> => {
  const since = new Date(Date.now() - 24 * 60 * 60_000);
  const [row] = await db
    .select({
      missing: sql<number>`count(*) FILTER (WHERE ${usageLogs.id} IS NULL)::int`,
      settled: sql<number>`count(*)::int`,
    })
    .from(usageHolds)
    .leftJoin(usageLogs, eq(usageLogs.holdId, usageHolds.id))
    .where(
      and(inArray(usageHolds.status, ['settled', 'expired']), gte(usageHolds.settledAt, since)),
    );
  const missing = Number(row?.missing ?? 0);
  return check(
    'usage_coverage',
    missing > 0 ? [`${missing} settled call(s) in the last 24h have no priced usage row`] : [],
    { missingLast24h: missing, settledLast24h: Number(row?.settled ?? 0) },
    missing > 0 ? 'warn' : 'ok',
  );
};

const openRouterOrphanCheck = async (
  db: LobeChatDatabase,
  deps: ReconciliationDeps,
): Promise<AicoReconciliationCheck> => {
  let keys: { hash: string; name: string }[] | null;
  try {
    keys = await (deps.listOpenRouterKeys ?? defaultListOpenRouterKeys)();
  } catch (error) {
    return check('openrouter_orphans', [(error as Error).message.slice(0, 80)], {}, 'error');
  }
  if (keys === null) return check('openrouter_orphans', [], { skipped: 'no management key' }, 'ok');

  const referenced = new Set<string>();
  const walletKeys = await db
    .select({ id: userWallets.openrouterKeyId })
    .from(userWallets)
    .where(isNotNull(userWallets.openrouterKeyId));
  const budgetKeys = await db
    .select({ id: memberBudgets.openrouterKeyId })
    .from(memberBudgets)
    .where(isNotNull(memberBudgets.openrouterKeyId));
  for (const { id } of [...walletKeys, ...budgetKeys]) referenced.add(id!);

  // Only keys the app minted are ours to judge; the model-list and test keys
  // an operator made by hand are named otherwise.
  const orphans = keys.filter((k) => k.name.startsWith('aico-') && !referenced.has(k.hash));
  return check(
    'openrouter_orphans',
    orphans.map((k) => `${k.name} (${k.hash.slice(0, 8)}) is enabled but unused`),
    { enabledKeys: keys.length },
    orphans.length > 0 ? 'warn' : 'ok',
  );
};

// ─── Runs ─────────────────────────────────────────────────────────────────

/** Every check, each isolated so one failure cannot hide the others. */
export const collectReconciliationChecks = async (
  db: LobeChatDatabase,
  deps: ReconciliationDeps = {},
): Promise<AicoReconciliationCheck[]> => {
  const activeProvider = (deps.managed ?? getManagedProviderClient()).providerId;
  const guarded = async (
    id: string,
    run: () => Promise<AicoReconciliationCheck | AicoReconciliationCheck[]>,
  ): Promise<AicoReconciliationCheck[]> => {
    try {
      const result = await run();
      return Array.isArray(result) ? result : [result];
    } catch (error) {
      return [check(id, [(error as Error).message.slice(0, 120)], {}, 'error')];
    }
  };

  return [
    ...(await guarded('wallet_ledger', () => walletLedgerCheck(db))),
    ...(await guarded('org_ledger', () => orgLedgerCheck(db))),
    ...(await guarded('ledger_actor', () => ledgerActorCheck(db))),
    ...(await guarded('float_liability', () => keyChecks(db, deps))),
    ...(await guarded('key_hygiene', () => keyHygieneCheck(db, activeProvider))),
    ...(await guarded('usage_coverage', () => usageCoverageCheck(db))),
    ...(await guarded('openrouter_orphans', () => openRouterOrphanCheck(db, deps))),
  ];
};

export const runReconciliation = async (
  db: LobeChatDatabase,
  params: { adminId?: string | null; trigger: 'cron' | 'manual' },
  deps: ReconciliationDeps = {},
): Promise<AicoReconciliationRunItem> => {
  if (params.trigger === 'manual') {
    const [latest] = await listReconciliationRuns(db, 1);
    if (latest && Date.now() - latest.startedAt.getTime() < MANUAL_RUN_COOLDOWN_MS) return latest;
  }

  const [run] = await db
    .insert(aicoReconciliationRuns)
    .values({
      status: 'ok',
      trigger: params.trigger,
      triggeredByAdminId: params.adminId ?? null,
    })
    .returning();

  let checks: AicoReconciliationCheck[] = [];
  let error: string | null = null;
  try {
    checks = await collectReconciliationChecks(db, deps);
  } catch (e) {
    error = (e as Error).message.slice(0, 500);
  }

  const [finished] = await db
    .update(aicoReconciliationRuns)
    .set({
      checks,
      error,
      finishedAt: new Date(),
      status: error ? 'error' : worstStatus(checks.map((c) => c.status)),
    })
    .where(eq(aicoReconciliationRuns.id, run.id))
    .returning();
  return finished;
};

export const listReconciliationRuns = (db: LobeChatDatabase, limit = 20) =>
  db
    .select()
    .from(aicoReconciliationRuns)
    .orderBy(desc(aicoReconciliationRuns.startedAt))
    .limit(limit);
