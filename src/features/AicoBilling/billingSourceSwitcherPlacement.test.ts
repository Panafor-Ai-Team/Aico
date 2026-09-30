import { describe, expect, it } from 'vitest';

import { BILLING_SOURCE_SWITCHER_PLACEMENT } from './billingSourceSwitcherPlacement';

describe('BILLING_SOURCE_SWITCHER_PLACEMENT', () => {
  it('opens the wallet menu below the trigger', () => {
    expect(BILLING_SOURCE_SWITCHER_PLACEMENT).toBe('bottom');
    expect(BILLING_SOURCE_SWITCHER_PLACEMENT.startsWith('top')).toBe(false);
  });
});
