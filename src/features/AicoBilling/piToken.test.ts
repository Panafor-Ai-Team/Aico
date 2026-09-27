import { describe, expect, it } from 'vitest';

import {
  formatCvcCoefficient,
  formatPiAmount,
  formatPiTokens,
  formatTokenCoefficient,
  rawUsdToCvcCoefficient,
  rawUsdToPiTokens,
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
