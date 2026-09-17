import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { LobeChatDatabase } from '@/database/type';

import {
  assertPlatformCapacity,
  FLOAT_REFRESH_INTERVAL_MS,
  refreshPlatformFloat,
  resetFloatGuardForTests,
} from '../floatGuard';

const h = vi.hoisted(() => ({
  aggregateOpenHoldsRaw: vi.fn(),
  claimFloatRefresh: vi.fn(),
  fetchKeyBalanceUsd: vi.fn(),
  sendSecurityAlert: vi.fn(),
  state: {} as Record<string, unknown>,
  sumChargedRaw: vi.fn(),
  updateState: vi.fn(),
}));

vi.mock('@/database/models/aicoUsageLedger', () => ({
  AicoUsageLedgerModel: class {
    aggregateOpenHoldsRaw = h.aggregateOpenHoldsRaw;
    claimFloatRefresh = h.claimFloatRefresh;
    sumChargedRaw = h.sumChargedRaw;
    updateState = h.updateState;
  },
}));

vi.mock('../../../managedProvider/cheapvibecode', () => ({
  fetchKeyBalanceUsd: h.fetchKeyBalanceUsd,
}));

vi.mock('../../securityAlert', () => ({ sendSecurityAlert: h.sendSecurityAlert }));

vi.mock('../config', () => ({
  getLedgerConfig: () => ({ floatFloorRawMicroUsd: 1_000_000, floatMaxAgeMs: 600_000 }),
}));

vi.mock('../state', () => ({
  getLedgerState: async () => h.state,
  invalidateLedgerStateCache: vi.fn(),
}));

const db = {} as LobeChatDatabase;
const SHARED = 'sk-shared';

const alertKeys = () =>
  h.sendSecurityAlert.mock.calls.map(([, p]) => `${p.dedupeKey}:${p.severity}`);

beforeEach(() => {
  vi.clearAllMocks();
  resetFloatGuardForTests();
  h.state = {};
  h.aggregateOpenHoldsRaw.mockResolvedValue(0);
  h.sumChargedRaw.mockResolvedValue(0);
  h.claimFloatRefresh.mockResolvedValue(true);
  h.sendSecurityAlert.mockResolvedValue({ sent: true });
  h.updateState.mockImplementation(async (patch: Record<string, unknown>) => {
    Object.assign(h.state, patch);
  });
});

describe('assertPlatformCapacity', () => {
  it('allows and warns when there is no reading and the fetch fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.fetchKeyBalanceUsd.mockRejectedValue(new Error('CheapVibeCode API 503'));

    await expect(
      assertPlatformCapacity({ db, holdRawMicroUsd: 1000, sharedKey: SHARED }),
    ).resolves.toBeUndefined();
    expect(alertKeys()).toEqual(['ledger:float_stale:warning']);
  });

  it('refuses below the floor with a critical alert', async () => {
    h.state = { floatRawMicroUsd: 5_000_000, floatReadAt: new Date() };
    h.sumChargedRaw.mockResolvedValue(2_000_000);
    h.aggregateOpenHoldsRaw.mockResolvedValue(1_500_000);

    await expect(
      assertPlatformCapacity({ db, holdRawMicroUsd: 600_000, sharedKey: SHARED }),
    ).rejects.toMatchObject({ code: 'PLATFORM_CAPACITY_EXHAUSTED:float_floor' });
    expect(alertKeys()).toEqual(['ledger:float_floor:critical']);
    expect(h.fetchKeyBalanceUsd).not.toHaveBeenCalled();
  });

  it('warns below twice the floor but allows', async () => {
    h.state = { floatRawMicroUsd: 1_800_000, floatReadAt: new Date() };

    await assertPlatformCapacity({ db, holdRawMicroUsd: 1000, sharedKey: SHARED });
    expect(alertKeys()).toEqual(['ledger:float_low:warning']);
  });

  it('allows silently with a healthy float', async () => {
    h.state = { floatRawMicroUsd: 50_000_000, floatReadAt: new Date() };

    await assertPlatformCapacity({ db, holdRawMicroUsd: 1000, sharedKey: SHARED });
    expect(h.sendSecurityAlert).not.toHaveBeenCalled();
  });

  it('fetches once for concurrent callers without a reading', async () => {
    let resolve!: (usd: number) => void;
    h.fetchKeyBalanceUsd.mockImplementation(() => new Promise((r) => (resolve = r)));

    const calls = Promise.all([
      assertPlatformCapacity({ db, holdRawMicroUsd: 1, sharedKey: SHARED }),
      assertPlatformCapacity({ db, holdRawMicroUsd: 1, sharedKey: SHARED }),
    ]);
    await vi.waitFor(() => expect(h.fetchKeyBalanceUsd).toHaveBeenCalled());
    resolve(40);
    await calls;

    expect(h.fetchKeyBalanceUsd).toHaveBeenCalledTimes(1);
    expect(h.state.floatRawMicroUsd).toBe(40_000_000);
    expect(h.sendSecurityAlert).not.toHaveBeenCalled();
  });

  it('refreshes a stale reading in the background without waiting', async () => {
    h.state = {
      floatRawMicroUsd: 50_000_000,
      floatReadAt: new Date(Date.now() - FLOAT_REFRESH_INTERVAL_MS - 1000),
    };
    h.fetchKeyBalanceUsd.mockImplementation(() => new Promise(() => {}));

    await expect(
      assertPlatformCapacity({ db, holdRawMicroUsd: 1, sharedKey: SHARED }),
    ).resolves.toBeUndefined();
    await vi.waitFor(() => expect(h.fetchKeyBalanceUsd).toHaveBeenCalledTimes(1));
  });
});

describe('refreshPlatformFloat', () => {
  it('skips the fetch when another process holds the claim', async () => {
    h.claimFloatRefresh.mockResolvedValue(false);
    await refreshPlatformFloat(db, SHARED);
    expect(h.fetchKeyBalanceUsd).not.toHaveBeenCalled();
  });

  it('never logs the shared key on failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.fetchKeyBalanceUsd.mockRejectedValue(new Error('CheapVibeCode API 401: Unauthorized'));

    await refreshPlatformFloat(db, SHARED);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(SHARED);
    expect(h.updateState).not.toHaveBeenCalled();
  });
});
