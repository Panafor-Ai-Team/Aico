import { cvcMultiplierToPricing } from '@lobechat/model-runtime';
import { afterEach, describe, expect, it } from 'vitest';

import {
  formatCvcCoefficient,
  formatIsolatedCoefficient,
  formatPiAmount,
  formatPiTokens,
  formatTokenCoefficient,
  getCvcTokensPerUsd,
  rawUsdToCvcCoefficient,
  rawUsdToPiTokens,
  setCvcTokensPerUsd,
} from './piToken';

describe('piToken rate formatting', () => {
  it('maps catalog USD rates to CVC coefficient (1× ≈ $0.04/M)', () => {
    expect(rawUsdToCvcCoefficient(0.04)).toBe(1);
    expect(rawUsdToCvcCoefficient(0.16)).toBe(4);
    expect(rawUsdToCvcCoefficient(0.28)).toBeCloseTo(7);
    expect(rawUsdToPiTokens(0.16)).toBe(4000);
  });

  it('formats token rates as a coefficient only', () => {
    expect(formatCvcCoefficient(4)).toBe('4×');
    expect(formatCvcCoefficient(0.33)).toBe('0.33×');
    expect(formatCvcCoefficient(62.5)).toBe('62.5×');
    expect(formatTokenCoefficient(0.16)).toBe('4×');
    expect(formatTokenCoefficient(0.08)).toBe('2×');
    expect(formatTokenCoefficient(2.5)).toBe('62.5×');
  });

  it('formats π amounts without the symbol for icon-based display', () => {
    expect(formatPiAmount(50)).toBe('50.00');
    expect(formatPiAmount(1250)).toBe('1,250');
    expect(formatPiAmount(0.5)).toBe('0.500');
    expect(formatPiAmount(0)).toBe('0');
    expect(formatPiAmount('abc')).toBe('0');
    expect(formatPiTokens(1250)).toBe('1,250 π');
  });
});

describe('shown coefficient equals the CVC multiplier', () => {
  afterEach(() => setCvcTokensPerUsd(undefined));

  // CVC publishes a `multiplier`; we store it as a USD rate and show it back.
  // Whatever the multiplier, the picker must show exactly what CVC published.
  const published = [0.05, 0.3, 0.33, 1, 1.25, 2, 4, 62.5];

  it.each(published)('round-trips %s× through the stored catalog price', (multiplier) => {
    const rate = (cvcMultiplierToPricing(multiplier)?.units[0] as { rate: number }).rate;
    expect(rawUsdToCvcCoefficient(rate)).toBeCloseTo(multiplier, 9);
    expect(formatTokenCoefficient(rate)).toBe(formatCvcCoefficient(multiplier));
  });

  it('follows the server CVC rate when it is not the 25M default', () => {
    setCvcTokensPerUsd(50_000_000);
    // 50M tokens/$ halves the USD price of a 1× model; the shown multiplier must stay 1×.
    expect(getCvcTokensPerUsd()).toBe(50_000_000);
    expect(formatTokenCoefficient(0.02)).toBe('1×');
  });

  it('falls back to the default for an invalid server value', () => {
    setCvcTokensPerUsd(0);
    expect(getCvcTokensPerUsd()).toBe(25_000_000);
    setCvcTokensPerUsd(Number.NaN);
    expect(getCvcTokensPerUsd()).toBe(25_000_000);
  });
});

describe('formatIsolatedCoefficient', () => {
  it('keeps the multiplier in one format and LTR-isolates it for RTL text', () => {
    // Admin screens used `x1.5` and `1.20x`; one `N×` everywhere, isolated so the
    // trailing × cannot mirror to `×4` in fa-IR.
    expect(formatIsolatedCoefficient(1.5)).toBe('\u20661.5×\u2069');
    expect(formatIsolatedCoefficient(1.2)).toBe('\u20661.2×\u2069');
    expect(formatIsolatedCoefficient(4)).toBe('\u20664×\u2069');
  });
});
