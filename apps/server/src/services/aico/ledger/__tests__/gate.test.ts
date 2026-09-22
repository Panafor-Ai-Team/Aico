import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { LobeChatDatabase } from '@/database/type';

import type { LedgerConfig } from '../config';
import { assertManagedTrafficAllowed } from '../gate';

const SHARED_KEY = 'sk-cvc-test-shared-key-do-not-leak';

const cfg = {} as LedgerConfig;
const baseConfig = (): LedgerConfig => ({
  cappedOutputModels: new Set(['glm-5.3-flash']),
  defaultMaxOutputTokens: 32_000,
  floatFloorRawMicroUsd: 1_000_000,
  floatMaxAgeMs: 600_000,
  holdTtlSeconds: 900,
  inferenceKey: 'per_subject',
  legacyPrimaryKeyExposed: false,
  managedProviderId: 'cheapvibecode',
  maxOpenHolds: 6,
  mode: 'enforce',
  sharedApiKey: null,
});

const state = vi.hoisted(() => ({
  current: {} as Record<string, unknown>,
  fail: false,
}));
const sendSecurityAlert = vi.hoisted(() => vi.fn());

vi.mock('../config', () => ({
  getLedgerConfig: () => cfg,
  isSharedInferenceKey: () => cfg.inferenceKey === 'shared',
}));

vi.mock('../state', () => ({
  getLedgerState: async () => {
    if (state.fail) throw new Error('db down');
    return state.current;
  },
}));

vi.mock('../../securityAlert', () => ({ sendSecurityAlert }));

const db = {} as LobeChatDatabase;

const expectRefusal = async (suffix: string) => {
  const error = await assertManagedTrafficAllowed(db).then(
    () => null,
    (e: Error) => e,
  );
  expect(error?.message).toBe(`PLATFORM_CAPACITY_EXHAUSTED:${suffix}`);
  expect(error?.message).not.toContain(SHARED_KEY);
  return error;
};

beforeEach(() => {
  Object.assign(cfg, baseConfig());
  state.fail = false;
  state.current = {
    enforceStartedAt: new Date(),
    paused: false,
    snapshotCompletedAt: new Date(),
  };
  sendSecurityAlert.mockReset().mockResolvedValue({ sent: true });
});

describe('assertManagedTrafficAllowed', () => {
  it('passes legacy traffic through in off mode', async () => {
    Object.assign(cfg, { mode: 'off' });
    state.current = { enforceStartedAt: null, paused: false, snapshotCompletedAt: null };
    await expect(assertManagedTrafficAllowed(db)).resolves.toEqual({
      authoritative: false,
      mode: 'off',
      sharedKey: null,
    });
  });

  it('passes shadow traffic without authority', async () => {
    Object.assign(cfg, { mode: 'shadow' });
    state.current = { enforceStartedAt: null, paused: false, snapshotCompletedAt: null };
    await expect(assertManagedTrafficAllowed(db)).resolves.toEqual({
      authoritative: false,
      mode: 'shadow',
      sharedKey: null,
    });
  });

  it('is authoritative under enforce once the snapshot is done', async () => {
    await expect(assertManagedTrafficAllowed(db)).resolves.toEqual({
      authoritative: true,
      mode: 'enforce',
      sharedKey: null,
    });
  });

  it('hands out the shared key under enforce + shared', async () => {
    Object.assign(cfg, { inferenceKey: 'shared', sharedApiKey: SHARED_KEY });
    await expect(assertManagedTrafficAllowed(db)).resolves.toEqual({
      authoritative: true,
      mode: 'enforce',
      sharedKey: SHARED_KEY,
    });
  });

  it('refuses shared mode without its key and alerts', async () => {
    Object.assign(cfg, { inferenceKey: 'shared', sharedApiKey: null });
    await expectRefusal('ledger_misconfigured');
    expect(sendSecurityAlert).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ dedupeKey: 'ledger:ledger_misconfigured', severity: 'critical' }),
    );
  });

  it('refuses shared mode while the unmetered env key is present', async () => {
    Object.assign(cfg, {
      inferenceKey: 'shared',
      legacyPrimaryKeyExposed: true,
      sharedApiKey: SHARED_KEY,
    });
    await expectRefusal('ledger_misconfigured');
    expect(JSON.stringify(sendSecurityAlert.mock.calls)).not.toContain(SHARED_KEY);
  });

  it.each(['off', 'shadow'] as const)('refuses shared mode with ledger %s', async (mode) => {
    Object.assign(cfg, { inferenceKey: 'shared', mode, sharedApiKey: SHARED_KEY });
    state.current = { enforceStartedAt: null, paused: false, snapshotCompletedAt: null };
    await expectRefusal('ledger_misconfigured');
  });

  it('refuses enforce on a provider the ledger cannot price', async () => {
    Object.assign(cfg, { managedProviderId: 'openrouter' });
    await expectRefusal('ledger_misconfigured');
  });

  it('treats shadow on another provider as off', async () => {
    Object.assign(cfg, { managedProviderId: 'openrouter', mode: 'shadow' });
    state.current = { enforceStartedAt: null, paused: false, snapshotCompletedAt: null };
    await expect(assertManagedTrafficAllowed(db)).resolves.toMatchObject({ mode: 'off' });
  });

  it('fails closed on a state read error under enforce', async () => {
    state.fail = true;
    await expectRefusal('state_unavailable');
  });

  it('fails open on a state read error under shadow', async () => {
    Object.assign(cfg, { mode: 'shadow' });
    state.fail = true;
    await expect(assertManagedTrafficAllowed(db)).resolves.toEqual({
      authoritative: false,
      mode: 'off',
      sharedKey: null,
    });
  });

  it.each(['off', 'shadow', 'enforce'] as const)(
    'refuses everything while paused (%s)',
    async (mode) => {
      Object.assign(cfg, { mode });
      state.current = { enforceStartedAt: null, paused: true, snapshotCompletedAt: null };
      await expectRefusal('paused');
    },
  );

  it.each(['off', 'shadow'] as const)(
    'refuses a downgrade to %s after the cutover',
    async (mode) => {
      Object.assign(cfg, { mode });
      await expectRefusal('enforce_downgrade');
      expect(sendSecurityAlert).toHaveBeenCalledWith(
        db,
        expect.objectContaining({ dedupeKey: 'ledger:enforce_downgrade', severity: 'critical' }),
      );
    },
  );

  it('refuses enforce until the snapshot completes', async () => {
    state.current = { enforceStartedAt: null, paused: false, snapshotCompletedAt: null };
    await expectRefusal('snapshot_pending');
  });

  it('still refuses when the alert itself fails', async () => {
    Object.assign(cfg, { inferenceKey: 'shared', sharedApiKey: null });
    sendSecurityAlert.mockRejectedValue(new Error('webhook down'));
    await expectRefusal('ledger_misconfigured');
  });
});
