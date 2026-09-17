import { AicoUsageLedgerModel } from '@/database/models/aicoUsageLedger';
import type { LobeChatDatabase } from '@/database/type';

import { sendSecurityAlert } from '../securityAlert';
import { getLedgerConfig } from './config';
import { refreshPlatformFloat } from './floatGuard';
import { getLedgerState, invalidateLedgerStateCache, isLedgerAuthoritative } from './state';

export const EXPIRE_BATCH_LIMIT = 500;
/** A float reading older than this is not trusted for reconciliation. */
export const RECONCILE_MAX_READING_AGE_MS = 2 * 60_000;
/** Upstream spend is compared with the ledger over windows at least this long. */
export const RECONCILE_WINDOW_MS = 60 * 60_000;
const ALERT_COOLDOWN_MS = 10 * 60_000;

export type ReconcileResult =
  | { skipped: 'no_float' | 'not_authoritative' | 'not_shared' }
  | { status: 'baseline_reset' }
  | { status: 'window_open'; windowMs: number }
  | {
      alert: 'critical' | 'warning' | null;
      ledgerSpend: number;
      status: 'checked';
      upstream: number;
      windowMs: number;
    };

/**
 * Compares what the shared CVC account actually lost with what the ledger
 * charged over the same window. Upstream spend well above ledger spend means
 * traffic is bypassing the ledger, e.g. a leaked primary key.
 */
const reconcile = async (db: LobeChatDatabase): Promise<ReconcileResult> => {
  const cfg = getLedgerConfig();
  if (cfg.inferenceKey !== 'shared' || !cfg.sharedApiKey) return { skipped: 'not_shared' };
  if (!(await isLedgerAuthoritative(db))) return { skipped: 'not_authoritative' };

  await refreshPlatformFloat(db, cfg.sharedApiKey);
  const state = await getLedgerState(db, { fresh: true });
  const float = state.floatRawMicroUsd == null ? null : Number(state.floatRawMicroUsd);
  const floatReadAt = state.floatReadAt ? new Date(state.floatReadAt) : null;
  if (
    float === null ||
    !floatReadAt ||
    Date.now() - floatReadAt.getTime() > RECONCILE_MAX_READING_AGE_MS
  ) {
    return { skipped: 'no_float' };
  }

  const ledger = new AicoUsageLedgerModel(db);
  const baseline =
    state.reconcileFloatRawMicroUsd == null ? null : Number(state.reconcileFloatRawMicroUsd);
  const baselineAt = state.reconcileReadAt ? new Date(state.reconcileReadAt) : null;

  // A higher balance means the account was topped up: spend cannot be measured
  // across a deposit, so start a new window.
  if (baseline === null || !baselineAt || float > baseline) {
    await ledger.updateState({
      reconcileFloatRawMicroUsd: float,
      reconcileReadAt: floatReadAt,
    });
    invalidateLedgerStateCache();
    return { status: 'baseline_reset' };
  }

  const windowMs = floatReadAt.getTime() - baselineAt.getTime();
  if (windowMs < RECONCILE_WINDOW_MS) return { status: 'window_open', windowMs };

  const upstream = baseline - float;
  const ledgerSpend = await ledger.sumChargedRaw({ from: baselineAt, to: floatReadAt });

  let alert: 'critical' | 'warning' | null = null;
  if (upstream > ledgerSpend * 1.25 + 1_000_000) alert = 'critical';
  else if (upstream > ledgerSpend * 1.05 + 100_000) alert = 'warning';

  if (alert) {
    await sendSecurityAlert(db, {
      cooldownMs: ALERT_COOLDOWN_MS,
      dedupeKey: 'ledger:reconcile',
      severity: alert,
      summary: `Shared CVC account spent ${upstream} raw µUSD in ${Math.round(windowMs / 60_000)} min; the usage ledger charged ${ledgerSpend}`,
      type: 'billing_ledger',
    }).catch(() => null);
  }

  await ledger.updateState({ reconcileFloatRawMicroUsd: float, reconcileReadAt: floatReadAt });
  invalidateLedgerStateCache();
  return { alert, ledgerSpend, status: 'checked', upstream, windowMs };
};

/**
 * Cron body: charges holds whose deadline passed, then reconciles the shared
 * account against the ledger. Expiry runs in every mode so shadow rows close too.
 */
export const runLedgerMaintenance = async (
  db: LobeChatDatabase,
): Promise<{ expired: number; reconcile: ReconcileResult }> => {
  const expired = await new AicoUsageLedgerModel(db).expireHolds({ limit: EXPIRE_BATCH_LIMIT });
  return { expired, reconcile: await reconcile(db) };
};
