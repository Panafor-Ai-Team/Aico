import { describe, expect, it, vi } from 'vitest';

import { STORE_DEFAULTS } from '../store';

vi.mock('@/const/dir', () => ({ appStorageDir: '/mock/storage' }));

vi.mock('@/modules/updater/configs', () => ({ UPDATE_CHANNEL: 'stable' }));

describe('STORE_DEFAULTS', () => {
  it('keeps the device gateway off with no hosted default URL', () => {
    // A fresh install must not report the user id and token to LobeHub's
    // device gateway (device-gateway.lobehub.com).
    expect(STORE_DEFAULTS.gatewayEnabled).toBe(false);
    expect(STORE_DEFAULTS.gatewayUrl).toBe('');
  });
});
