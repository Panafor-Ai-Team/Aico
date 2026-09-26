import { describe, expect, it } from 'vitest';

import {
  formatCvcCoefficient,
  formatHybridPiRate,
  formatPiRateAmount,
  rawUsdToCvcCoefficient,
  rawUsdToPiTokens,
} from './piToken';

describe('piToken hybrid rate formatting', () => {
  it('maps catalog USD rates to CVC coefficient (1× ≈ $0.04/M)', () => {
    expect(rawUsdToCvcCoefficient(0.04)).toBe(1);
    expect(rawUsdToCvcCoefficient(0.16)).toBe(4);
    expect(rawUsdToCvcCoefficient(0.28)).toBeCloseTo(7);
    expect(rawUsdToPiTokens(0.16)).toBe(4000);
  });

  it('formats coefficients and hybrid token rates', () => {
    expect(formatCvcCoefficient(4)).toBe('4×');
    expect(formatCvcCoefficient(0.33)).toBe('0.33×');
    expect(formatCvcCoefficient(62.5)).toBe('62.5×');
    expect(formatPiRateAmount(4000)).toBe('4,000');
    expect(formatHybridPiRate(0.16)).toBe('4× · 4,000');
    expect(formatHybridPiRate(2.5)).toBe('62.5× · 62,500');
  });
});
