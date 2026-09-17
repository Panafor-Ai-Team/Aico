import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { LobeChatDatabase } from '@/database/type';

import type { LedgerConfig } from '../config';
import {
  getLedgerState,
  isLedgerAuthoritative,
  isLedgerPaused,
  resetLedgerStateCacheForTests,
} from '../state';

const cfg = { mode: 'enforce' } as LedgerConfig;
const getState = vi.hoisted(() => vi.fn());

vi.mock('../config', () => ({ getLedgerConfig: () => cfg }));
vi.mock('@/database/models/aicoUsageLedger', () => ({
  AicoUsageLedgerModel: class {
    getState = getState;
  },
}));

const db = {} as LobeChatDatabase;

beforeEach(() => {
  resetLedgerStateCacheForTests();
  cfg.mode = 'enforce';
  getState.mockReset();
});

describe('ledger state', () => {
  it('caches the state row and bypasses the cache on a fresh read', async () => {
    getState.mockResolvedValue({ paused: false });
    await getLedgerState(db);
    await getLedgerState(db);
    expect(getState).toHaveBeenCalledTimes(1);
    await getLedgerState(db, { fresh: true });
    expect(getState).toHaveBeenCalledTimes(2);
  });

  it('is authoritative only under enforce with a completed snapshot', async () => {
    getState.mockResolvedValue({ snapshotCompletedAt: new Date() });
    expect(await isLedgerAuthoritative(db)).toBe(true);

    cfg.mode = 'shadow';
    expect(await isLedgerAuthoritative(db)).toBe(false);

    cfg.mode = 'enforce';
    resetLedgerStateCacheForTests();
    getState.mockResolvedValue({ snapshotCompletedAt: null });
    expect(await isLedgerAuthoritative(db)).toBe(false);
  });

  it('propagates a state read failure from isLedgerAuthoritative', async () => {
    getState.mockRejectedValue(new Error('db down'));
    await expect(isLedgerAuthoritative(db)).rejects.toThrow('db down');
  });

  it('treats an unreadable state as paused only under enforce', async () => {
    getState.mockRejectedValue(new Error('db down'));
    expect(await isLedgerPaused(db)).toBe(true);
    cfg.mode = 'shadow';
    expect(await isLedgerPaused(db)).toBe(false);
  });
});
