import { describe, expect, it } from 'vitest';

import type { AicoPersonalBillingSource } from '@/features/AicoBilling';

import { resolveWalletDisplay } from './resolveWalletDisplay';

const personal = (
  overrides: Partial<AicoPersonalBillingSource> = {},
): AicoPersonalBillingSource => ({
  hasManagedKey: true,
  isActive: true,
  remainingMicroUsd: '9600000',
  remainingToman: '480000',
  remainingUsd: '9.600000',
  source: 'personal',
  usageKnown: true,
  ...overrides,
});

describe('resolveWalletDisplay (FIN-016)', () => {
  // The reported incident: top up 500,000 toman, spend $0.40, and the wallet
  // still reads 500,000 toman because the toman card was cumulative deposits.
  const paidIn = { paidInToman: 500_000, paidInUsd: '10.000000' };

  it('shows remaining, not deposits, in both currencies', () => {
    const display = resolveWalletDisplay({ ...paidIn, personal: personal() });

    expect(display.remainingUsd).toBe('$9.6000');
    expect(display.remainingToman).toBe((480_000).toLocaleString());

    // The deposits are still shown — but only as what was paid in.
    expect(display.paidInUsd).toBe('$10.0000');
    expect(display.paidInToman).toBe((500_000).toLocaleString());
  });

  it('never substitutes the deposit when remaining could not be computed', () => {
    const display = resolveWalletDisplay({ ...paidIn, personal: undefined });

    // The old code rendered `$10.0000` here, under a label reading as credit.
    expect(display.remainingUsd).toBeNull();
    expect(display.remainingToman).toBeNull();
    expect(display.paidInUsd).toBe('$10.0000');
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
      personal: personal({ remainingMicroUsd: '0', remainingToman: '0', remainingUsd: '0.000000' }),
    });

    expect(display.remainingUsd).toBe('$0.0000');
    expect(display.remainingToman).toBe('0');
    expect(display.paidInToman).toBe((500_000).toLocaleString());
  });
});
