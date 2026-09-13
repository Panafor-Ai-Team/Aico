import { describe, expect, it } from 'vitest';

import {
  confirmedUnusedMicro,
  currentCycleLimitMicroUsd,
  cycleRemainingMicroUsd,
  isProductBudgetPeriod,
  isStaleManagedKeyId,
  microUsdToDecimalString,
  openRouterUsdToMicroFloor,
  periodToOpenRouterLimitReset,
  remainingTomanFromBalance,
  tomanToMicroUsd,
  usdDecimalStringToMicro,
} from '../aicoMoney';

describe('aicoMoney (final remediation)', () => {
  it('maps periods to OpenRouter limit_reset', () => {
    expect(periodToOpenRouterLimitReset('total')).toBeNull();
    expect(periodToOpenRouterLimitReset('daily')).toBe('daily');
    expect(periodToOpenRouterLimitReset('weekly')).toBe('weekly');
    expect(periodToOpenRouterLimitReset('monthly')).toBe('monthly');
  });

  it('product periods exclude total', () => {
    expect(isProductBudgetPeriod('daily')).toBe(true);
    expect(isProductBudgetPeriod('weekly')).toBe(true);
    expect(isProductBudgetPeriod('monthly')).toBe(true);
    expect(isProductBudgetPeriod('total')).toBe(false);
  });

  it('round-trips precision-heavy decimals as strings', () => {
    const micro = usdDecimalStringToMicro('12.345678');
    expect(micro).toBe(12_345_678n);
    expect(microUsdToDecimalString(micro)).toBe('12.345678');
  });

  it('handles very large values without float', () => {
    const micro = usdDecimalStringToMicro('999999999.123456');
    expect(microUsdToDecimalString(micro)).toBe('999999999.123456');
  });

  it('sums repeatedly in integer space', () => {
    let sum = 0n;
    for (let i = 0; i < 1000; i++) sum += usdDecimalStringToMicro('0.000001');
    expect(sum).toBe(1000n);
    expect(microUsdToDecimalString(sum)).toBe('0.001000');
  });

  it('floors OpenRouter USD and never over-refunds', () => {
    expect(openRouterUsdToMicroFloor(1.9999999)).toBe(1_999_999n);
    expect(confirmedUnusedMicro(1_000_000n, 400_001n)).toBe(599_999n);
    expect(confirmedUnusedMicro(100n, 200n)).toBe(0n);
  });

  it('FX toman→micro floors toward Aico', () => {
    // 50_001 toman at 50_000 toman/USD → floor to < 1.000020 USD
    expect(tomanToMicroUsd(50_001, 50_000)).toBe(1_000_020n);
  });

  it('rejects malformed / negative / non-decimal money inputs', () => {
    expect(() => usdDecimalStringToMicro('NaN')).toThrow();
    expect(() => usdDecimalStringToMicro('Infinity')).toThrow();
    expect(() => usdDecimalStringToMicro('1.2.3')).toThrow();
    expect(() => tomanToMicroUsd(-1, 50_000)).toThrow();
    expect(() => openRouterUsdToMicroFloor(Number.NaN)).toThrow();
  });

  it('cycle remaining uses periodAmount and ignores pending reserved hold (FIN-001)', () => {
    const budget = {
      periodAmountMicroUsd: 10_000_000,
      reservedMicroUsd: 30_000_000,
      settledUsageMicroUsd: 2_000_000,
    };
    expect(currentCycleLimitMicroUsd(budget)).toBe(10_000_000);
    expect(cycleRemainingMicroUsd(budget)).toBe(8_000_000);
  });

  it('isStaleManagedKeyId treats mock_ hashes as invalid', () => {
    expect(isStaleManagedKeyId(null)).toBe(true);
    expect(isStaleManagedKeyId('mock_abc')).toBe(true);
    expect(isStaleManagedKeyId('ctrl_realhash')).toBe(false);
  });

  describe('remainingTomanFromBalance (FIN-016)', () => {
    // 500,000 toman bought $10 of credit. The toman view of what is left must
    // track spend, which the cumulative `balance_toman` column never did.
    const paid = { balanceMicroUsd: 10_000_000, balanceToman: 500_000 };

    it('tracks spend rather than staying at the deposited figure', () => {
      expect(remainingTomanFromBalance({ ...paid, remainingMicroUsd: 10_000_000 })).toBe(500_000);
      expect(remainingTomanFromBalance({ ...paid, remainingMicroUsd: 9_520_000 })).toBe(476_000);
      expect(remainingTomanFromBalance({ ...paid, remainingMicroUsd: 0 })).toBe(0);
    });

    it('floors, so the toman figure is never optimistic', () => {
      // 1/3 of 100 toman is 33.33 — the user is shown 33.
      expect(
        remainingTomanFromBalance({
          balanceMicroUsd: 3_000_000,
          balanceToman: 100,
          remainingMicroUsd: 1_000_000,
        }),
      ).toBe(33);
    });

    it('never exceeds what was paid in, and survives an empty wallet', () => {
      expect(remainingTomanFromBalance({ ...paid, remainingMicroUsd: 99_000_000 })).toBe(500_000);
      expect(
        remainingTomanFromBalance({
          balanceMicroUsd: 0,
          balanceToman: 0,
          remainingMicroUsd: 0,
        }),
      ).toBe(0);
      expect(
        remainingTomanFromBalance({
          balanceMicroUsd: null,
          balanceToman: undefined,
          remainingMicroUsd: 5_000_000,
        }),
      ).toBe(0);
    });

    it('does not move when the FX rate moves', () => {
      // The whole point of pro-rating instead of converting at today's rate.
      const first = remainingTomanFromBalance({ ...paid, remainingMicroUsd: 6_000_000 });
      const second = remainingTomanFromBalance({ ...paid, remainingMicroUsd: 6_000_000 });
      expect(first).toBe(second);
      expect(first).toBe(300_000);
    });
  });
});
