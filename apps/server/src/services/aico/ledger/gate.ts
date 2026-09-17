import type { LobeChatDatabase } from '@/database/type';

import { AicoManagedPolicyError } from '../managedPolicy';
import { sendSecurityAlert } from '../securityAlert';
import { getLedgerConfig, type LedgerMode } from './config';
import { getLedgerState } from './state';

export interface LedgerGate {
  /** Balances and holds come from the ledger (enforce with a finished snapshot). */
  authoritative: boolean;
  mode: LedgerMode;
  /** The one upstream key for all managed traffic; null unless shared mode. Never log. */
  sharedKey: string | null;
}

export type LedgerRefusal =
  | 'enforce_downgrade'
  | 'ledger_misconfigured'
  | 'paused'
  | 'snapshot_pending'
  | 'state_unavailable';

const ALERT_COOLDOWN_MS = 10 * 60_000;

const refuse = (suffix: LedgerRefusal): never => {
  throw new AicoManagedPolicyError(`PLATFORM_CAPACITY_EXHAUSTED:${suffix}`);
};

const alert = async (db: LobeChatDatabase, suffix: LedgerRefusal, summary: string) => {
  // An alert failure must never change whether traffic is allowed.
  await sendSecurityAlert(db, {
    cooldownMs: ALERT_COOLDOWN_MS,
    dedupeKey: `ledger:${suffix}`,
    severity: 'critical',
    summary,
    type: 'billing_ledger',
  }).catch(() => null);
};

/**
 * Decides whether managed traffic may run at all under the current ledger
 * configuration, before any wallet or budget is looked at.
 */
export const assertManagedTrafficAllowed = async (db: LobeChatDatabase): Promise<LedgerGate> => {
  const cfg = getLedgerConfig();
  const shared = cfg.inferenceKey === 'shared';
  let mode = cfg.mode;

  // 1. Shared mode needs its key, and must not coexist with the unmetered env key.
  if (shared && (!cfg.sharedApiKey || cfg.legacyPrimaryKeyExposed)) {
    await alert(
      db,
      'ledger_misconfigured',
      cfg.sharedApiKey
        ? 'Shared inference key mode is refusing traffic: CHEAPVIBECODE_API_KEY is set on the product server'
        : 'Shared inference key mode is refusing traffic: AICO_SHARED_INFERENCE_API_KEY is empty',
    );
    refuse('ledger_misconfigured');
  }

  // 2. The ledger only prices CheapVibeCode.
  if (mode !== 'off' && cfg.managedProviderId !== 'cheapvibecode') {
    if (mode === 'enforce') {
      await alert(
        db,
        'ledger_misconfigured',
        'Ledger enforce mode is refusing traffic: the managed provider is not CheapVibeCode',
      );
      refuse('ledger_misconfigured');
    }
    mode = 'off';
  }

  // Shared mode only makes sense with the ledger enforcing every call.
  if (shared && mode !== 'enforce') refuse('ledger_misconfigured');

  // 3. State read.
  let state;
  try {
    state = await getLedgerState(db);
  } catch {
    if (mode === 'enforce') refuse('state_unavailable');
    return { authoritative: false, mode: 'off', sharedKey: null };
  }

  // 4. Emergency brake, in every mode.
  if (state.paused) refuse('paused');

  // 5. Per-key brakes know nothing about spend recorded after the cutover.
  if (mode !== 'enforce' && state.enforceStartedAt) {
    await alert(
      db,
      'enforce_downgrade',
      'Managed traffic refused: ledger mode was lowered after the enforce cutover',
    );
    refuse('enforce_downgrade');
  }

  if (mode !== 'enforce') return { authoritative: false, mode, sharedKey: null };

  // 6. Enforce without a snapshot has no trustworthy balances.
  if (!state.snapshotCompletedAt) refuse('snapshot_pending');

  return { authoritative: true, mode, sharedKey: shared ? cfg.sharedApiKey : null };
};
