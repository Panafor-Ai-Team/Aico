import { describe, expect, it } from 'vitest';

import type { AicoPersonalBillingSource } from '@/features/AicoBilling';

import { resolveWalletDisplay } from './resolveWalletDisplay';

const personal = (
  overrides: Partial<AicoPersonalBillingSource> = {},
): AicoPersonalBillingSource => ({
  hasManagedKey: true,
  isActive: true,
  remainingMicroUsd: '9600000',
  remainingPi: '192000',
  remainingToman: '480000',
  remainingUsd: '9.600000',
  source: 'personal',
  usageKnown: true,
  ...overrides,
});

describe('resolveWalletDisplay (π tokens)', () => {
  const paidIn = { paidInPi: '200000' };

  it('shows remaining π, not the deposit total', () => {
    const display = resolveWalletDisplay({ ...paidIn, personal: personal() });

    expect(display.remainingPi).toBe('192,000 π');
    expect(display.paidInPi).toBe('200,000 π');
  });

  it('never substitutes the deposit when remaining could not be computed', () => {
    const display = resolveWalletDisplay({ ...paidIn, personal: undefined });

    expect(display.remainingPi).toBeNull();
    expect(display.paidInPi).toBe('200,000 π');
  });

  it('flags a held figure as stale so it is not presented as current (FIN-018)', () => {
    expect(resolveWalletDisplay({ ...paidIn, personal: personal() }).stale).toBe(false);
    expect(
      resolveWalletDisplay({ ...paidIn, personal: personal({ usageKnown: false }) }).stale,
    ).toBe(true);
  });

  it('renders a spent-out wallet as zero credit against a non-zero deposit', () => {
    const display = resolveWalletDisplay({
      ...paidIn,
      personal: personal({ remainingMicroUsd: '0', remainingPi: '0', remainingUsd: '0.000000' }),
    });

    expect(display.remainingPi).toBe('0 π');
    expect(display.paidInPi).toBe('200,000 π');
  });
});
