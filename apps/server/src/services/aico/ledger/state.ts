import { AicoUsageLedgerModel } from '@/database/models/aicoUsageLedger';
import type { AicoLedgerStateItem } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';

import { getLedgerConfig } from './config';

/** A pause flipped in the database takes effect within this window. */
export const LEDGER_STATE_CACHE_MS = 5000;

let cached: { expiresAt: number; state: AicoLedgerStateItem } | null = null;

/**
 * The `aico_ledger_state` control row, cached in-process. Throws when the row
 * cannot be read: callers decide whether that fails open or closed.
 */
export const getLedgerState = async (
  db: LobeChatDatabase,
  options: { fresh?: boolean } = {},
): Promise<AicoLedgerStateItem> => {
  const now = Date.now();
  if (!options.fresh && cached && cached.expiresAt > now) return cached.state;

  const state = await new AicoUsageLedgerModel(db).getState();
  cached = { expiresAt: now + LEDGER_STATE_CACHE_MS, state };
  return state;
};

export const invalidateLedgerStateCache = () => {
  cached = null;
};

export const resetLedgerStateCacheForTests = invalidateLedgerStateCache;

/**
 * True only once enforce has completed its cutover snapshot. Only then do
 * balances come from ledger columns instead of upstream keys. Throws if the
 * state row cannot be read; that is an error, never "legacy".
 */
export const isLedgerAuthoritative = async (db: LobeChatDatabase): Promise<boolean> => {
  if (getLedgerConfig().mode !== 'enforce') return false;
  return Boolean((await getLedgerState(db)).snapshotCompletedAt);
};

/** Fresh read. An unreadable state counts as paused only under enforce. */
export const isLedgerPaused = async (db: LobeChatDatabase): Promise<boolean> => {
  try {
    return (await getLedgerState(db, { fresh: true })).paused;
  } catch {
    return getLedgerConfig().mode === 'enforce';
  }
};
