import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { LobeChatDatabase } from '@/database/type';

import { RECONCILE_WINDOW_MS, runLedgerMaintenance } from '../maintenance';

const h = vi.hoisted(() => ({
  authoritative: true,
  cfg: { inferenceKey: 'shared', sharedApiKey: 'sk-shared' } as Record<string, unknown>,
  expireHolds: vi.fn(),
  refreshPlatformFloat: vi.fn(),
  sendSecurityAlert: vi.fn(),
  state: {} as Record<string, unknown>,
  sumChargedRaw: vi.fn(),
  updateState: vi.fn(),
}));

vi.mock('@/database/models/aicoUsageLedger', () => ({
  AicoUsageLedgerModel: class {
    expireHolds = h.expireHolds;
    sumChargedRaw = h.sumChargedRaw;
    updateState = h.updateState;
  },
}));

vi.mock('../../securityAlert', () => ({ sendSecurityAlert: h.sendSecurityAlert }));
vi.mock('../config', () => ({ getLedgerConfig: () => h.cfg }));
vi.mock('../floatGuard', () => ({ refreshPlatformFloat: h.refreshPlatformFloat }));
vi.mock('../state', () => ({
  getLedgerState: async () => h.state,
  invalidateLedgerStateCache: vi.fn(),
  isLedgerAuthoritative: async () => h.authoritative,
}));

const db = {} as LobeChatDatabase;
const now = () => new Date();
const hourAgo = () => new Date(Date.now() - RECONCILE_WINDOW_MS - 1000);

beforeEach(() => {
  vi.clearAllMocks();
  h.authoritative = true;
  h.cfg = { inferenceKey: 'shared', sharedApiKey: 'sk-shared' };
  h.state = {};
  h.expireHolds.mockResolvedValue(3);
  h.refreshPlatformFloat.mockResolvedValue(undefined);
  h.sendSecurityAlert.mockResolvedValue({ sent: true });
  h.sumChargedRaw.mockResolvedValue(0);
  h.updateState.mockResolvedValue(undefined);
});

/** Baseline $100 an hour ago; `float` is the current reading. */
const windowState = (float: number) => {
  h.state = {
    floatRawMicroUsd: float,
    floatReadAt: now(),
    reconcileFloatRawMicroUsd: 100_000_000,
    reconcileReadAt: hourAgo(),
  };
};

describe('runLedgerMaintenance', () => {
  it('expires due holds and skips reconcile outside shared mode', async () => {
    h.cfg = { inferenceKey: 'per_subject', sharedApiKey: null };

    await expect(runLedgerMaintenance(db)).resolves.toEqual({
      expired: 3,
      reconcile: { skipped: 'not_shared' },
    });
    expect(h.expireHolds).toHaveBeenCalledWith({ limit: 500 });
    expect(h.refreshPlatformFloat).not.toHaveBeenCalled();
  });

  it('skips reconcile before the cutover snapshot', async () => {
    h.authoritative = false;
    const { reconcile } = await runLedgerMaintenance(db);
    expect(reconcile).toEqual({ skipped: 'not_authoritative' });
  });

  it('skips reconcile without a fresh float reading', async () => {
    h.state = { floatRawMicroUsd: 1, floatReadAt: new Date(Date.now() - 5 * 60_000) };
    const { reconcile } = await runLedgerMaintenance(db);
    expect(reconcile).toEqual({ skipped: 'no_float' });
  });

  it('resets the baseline when the account was topped up', async () => {
    windowState(150_000_000);
    const { reconcile } = await runLedgerMaintenance(db);

    expect(reconcile).toEqual({ status: 'baseline_reset' });
    expect(h.updateState).toHaveBeenCalledWith(
      expect.objectContaining({ reconcileFloatRawMicroUsd: 150_000_000 }),
    );
    expect(h.sendSecurityAlert).not.toHaveBeenCalled();
  });

  it('waits until the window is an hour long', async () => {
    windowState(90_000_000);
    h.state.reconcileReadAt = new Date(Date.now() - 10 * 60_000);
    const { reconcile } = await runLedgerMaintenance(db);
    expect(reconcile).toMatchObject({ status: 'window_open' });
    expect(h.updateState).not.toHaveBeenCalled();
  });

  it('stays quiet within tolerance', async () => {
    windowState(90_000_000);
    h.sumChargedRaw.mockResolvedValue(10_000_000);

    const { reconcile } = await runLedgerMaintenance(db);
    expect(reconcile).toMatchObject({ alert: null, ledgerSpend: 10_000_000, upstream: 10_000_000 });
    expect(h.sendSecurityAlert).not.toHaveBeenCalled();
    expect(h.updateState).toHaveBeenCalledWith(
      expect.objectContaining({ reconcileFloatRawMicroUsd: 90_000_000 }),
    );
  });

  it('warns when upstream spend runs past 1.05x plus $0.10', async () => {
    windowState(100_000_000 - 10_700_000);
    h.sumChargedRaw.mockResolvedValue(10_000_000);

    const { reconcile } = await runLedgerMaintenance(db);
    expect(reconcile).toMatchObject({ alert: 'warning' });
    expect(h.sendSecurityAlert.mock.calls[0][1]).toMatchObject({
      dedupeKey: 'ledger:reconcile',
      severity: 'warning',
    });
  });

  it('raises a critical alert past 1.25x plus $1 and never includes the shared key', async () => {
    windowState(100_000_000 - 13_600_000);
    h.sumChargedRaw.mockResolvedValue(10_000_000);

    const { reconcile } = await runLedgerMaintenance(db);
    expect(reconcile).toMatchObject({ alert: 'critical' });
    expect(JSON.stringify(h.sendSecurityAlert.mock.calls)).not.toContain('sk-shared');
  });
});
