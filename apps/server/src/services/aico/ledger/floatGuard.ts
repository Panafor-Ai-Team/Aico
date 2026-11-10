import { AicoUsageLedgerModel } from '@/database/models/aicoUsageLedger';
import type { LobeChatDatabase } from '@/database/type';

import { fetchKeyBalanceUsd } from '../../managedProvider/cheapvibecode';
import { AicoManagedPolicyError } from '../managedPolicy';
import { sendSecurityAlert } from '../securityAlert';
import { getLedgerConfig } from './config';
import { getLedgerState, invalidateLedgerStateCache } from './state';

/** A reading older than this triggers a background refresh. */
export const FLOAT_REFRESH_INTERVAL_MS = 60_000;
const AGGREGATE_CACHE_MS = 5000;
const FLOOR_ALERT_COOLDOWN_MS = 10 * 60_000;
const LOW_ALERT_COOLDOWN_MS = 30 * 60_000;

let inflight: Promise<void> | null = null;
let aggregates: {
  expiresAt: number;
  floatReadAt: number;
  openHoldsRaw: number;
  settledSince: number;
} | null = null;

export const resetFloatGuardForTests = () => {
  inflight = null;
  aggregates = null;
};

const alert = (
  db: LobeChatDatabase,
  params: {
    cooldownMs: number;
    dedupeKey: string;
    severity: 'critical' | 'warning';
    summary: string;
  },
) => sendSecurityAlert(db, { ...params, type: 'billing_ledger' }).catch(() => null);

/**
 * Reads the shared key's upstream balance into `aico_ledger_state`. One refresh
 * per process at a time, and one across processes per 30s via the claim CAS.
 * Failures keep the previous reading.
 */
export const refreshPlatformFloat = (db: LobeChatDatabase, sharedKey: string): Promise<void> => {
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const ledger = new AicoUsageLedgerModel(db);
      if (!(await ledger.claimFloatRefresh())) return;

      const usd = await fetchKeyBalanceUsd(sharedKey);
      if (!Number.isFinite(usd)) throw new Error('non-numeric balance');

      await ledger.updateState({
        floatRawMicroUsd: Math.max(0, Math.floor(usd * 1e6)),
        floatReadAt: new Date(),
      });
      invalidateLedgerStateCache();
    } catch (error) {
      // Message only: the request carried the shared key in its headers.
      console.warn('[aico-ledger] platform float refresh failed:', (error as Error)?.message);
    } finally {
      inflight = null;
    }
  })();

  return inflight;
};

const loadAggregates = async (db: LobeChatDatabase, floatReadAt: Date) => {
  const now = Date.now();
  if (aggregates && aggregates.expiresAt > now && aggregates.floatReadAt === floatReadAt.getTime())
    return aggregates;

  const ledger = new AicoUsageLedgerModel(db);
  const [openHoldsRaw, settledSince] = await Promise.all([
    ledger.aggregateOpenHoldsRaw(),
    ledger.sumChargedRaw({ from: floatReadAt, to: new Date(now) }),
  ]);
  aggregates = {
    expiresAt: now + AGGREGATE_CACHE_MS,
    floatReadAt: floatReadAt.getTime(),
    openHoldsRaw,
    settledSince,
  };
  return aggregates;
};

/**
 * Shared-key mode only: refuses a hold that would take the upstream account
 * below the configured floor, counting spend since the last reading and every
 * open hold. A missing or stale reading alerts but never blocks on its own.
 */
export const assertPlatformCapacity = async (params: {
  db: LobeChatDatabase;
  holdRawMicroUsd: number;
  sharedKey: string;
}): Promise<void> => {
  const { db, holdRawMicroUsd, sharedKey } = params;
  const cfg = getLedgerConfig();

  let state = await getLedgerState(db);
  const readAt = state.floatReadAt ? new Date(state.floatReadAt).getTime() : null;

  if (readAt === null || Date.now() - readAt > FLOAT_REFRESH_INTERVAL_MS) {
    const refresh = refreshPlatformFloat(db, sharedKey);
    if (state.floatRawMicroUsd == null) {
      await refresh;
      state = await getLedgerState(db, { fresh: true });
    } else {
      void refresh;
    }
  }

  const float = state.floatRawMicroUsd;
  const floatReadAt = state.floatReadAt ? new Date(state.floatReadAt) : null;
  if (float == null || !floatReadAt || Date.now() - floatReadAt.getTime() > cfg.floatMaxAgeMs) {
    await alert(db, {
      cooldownMs: FLOOR_ALERT_COOLDOWN_MS,
      dedupeKey: 'ledger:float_stale',
      severity: 'warning',
      summary: 'Shared-key float reading is missing or stale; managed traffic is not float-guarded',
    });
    return;
  }

  const { openHoldsRaw, settledSince } = await loadAggregates(db, floatReadAt);
  const effective = Number(float) - settledSince - openHoldsRaw - Math.max(0, holdRawMicroUsd);
  const floor = cfg.floatFloorRawMicroUsd;

  if (effective < floor) {
    await alert(db, {
      cooldownMs: FLOOR_ALERT_COOLDOWN_MS,
      dedupeKey: 'ledger:float_floor',
      severity: 'critical',
      summary: 'Managed traffic refused: shared-key upstream float is below the configured floor',
    });
    throw new AicoManagedPolicyError('PLATFORM_CAPACITY_EXHAUSTED:float_floor');
  }

  if (effective < 2 * floor) {
    await alert(db, {
      cooldownMs: LOW_ALERT_COOLDOWN_MS,
      dedupeKey: 'ledger:float_low',
      severity: 'warning',
      summary: 'Shared-key upstream float is below twice the configured floor',
    });
  }
};
