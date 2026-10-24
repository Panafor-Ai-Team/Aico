// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  __resetFxCacheForTests,
  __setFxLiveFetchImplForTests,
  getTomanPerUsd,
  toIntegerTomanPerUsd,
} from './fxService';

afterEach(() => {
  __resetFxCacheForTests();
  __setFxLiveFetchImplForTests(async () => {
    throw new Error('live FX disabled in test default');
  });
});

describe('toIntegerTomanPerUsd', () => {
  it('rounds fractional live FX rates so BigInt conversion is safe', () => {
    // Regression: platformAdmin.getPlatformFinancials did BigInt(fx.rate) on
    // 126510.0632387 (IRR/10) and threw RangeError.
    expect(toIntegerTomanPerUsd(126_510.063_238_7)).toBe(126_510);
    expect(() => BigInt(toIntegerTomanPerUsd(126_510.063_238_7))).not.toThrow();
  });

  it('rejects non-positive / non-finite rates', () => {
    expect(() => toIntegerTomanPerUsd(0)).toThrow('INVALID_FX_RATE');
    expect(() => toIntegerTomanPerUsd(-1)).toThrow('INVALID_FX_RATE');
    expect(() => toIntegerTomanPerUsd(Number.NaN)).toThrow('INVALID_FX_RATE');
  });
});

describe('getTomanPerUsd', () => {
  it('caches an integer live rate (never returns a float)', async () => {
    __setFxLiveFetchImplForTests(async () => 126_510.063_238_7);
    const first = await getTomanPerUsd();
    expect(first).toEqual({ rate: 126_510, source: 'live' });
    expect(Number.isInteger(first.rate)).toBe(true);

    // Cache hit still integer.
    const second = await getTomanPerUsd();
    expect(second).toEqual({ rate: 126_510, source: 'live' });
  });

  it('C8: says so when it falls back to the env rate', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    __setFxLiveFetchImplForTests(async () => {
      throw new Error('network down');
    });

    const result = await getTomanPerUsd();

    expect(result.source).toBe('env');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('FX live rate unavailable'),
      expect.any(Error),
    );
    warn.mockRestore();
  });

  it('does not warn when an admin rate is set or the live rate is available', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    __setFxLiveFetchImplForTests(async () => 120_000);

    await getTomanPerUsd(150_000);
    await getTomanPerUsd();

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('falls back to env integer rate when live fetch fails', async () => {
    __setFxLiveFetchImplForTests(async () => {
      throw new Error('network down');
    });
    const result = await getTomanPerUsd();
    expect(result.source).toBe('env');
    expect(Number.isInteger(result.rate)).toBe(true);
    expect(result.rate).toBeGreaterThan(0);
  });

  it('prefers platform admin rate over live / env', async () => {
    __setFxLiveFetchImplForTests(async () => 126_510);
    const result = await getTomanPerUsd(187_400);
    expect(result).toEqual({ rate: 187_400, source: 'admin' });
  });
});
