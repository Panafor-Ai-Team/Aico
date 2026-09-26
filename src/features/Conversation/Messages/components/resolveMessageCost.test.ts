import type { ModelUsage } from '@lobechat/types';
import { describe, expect, it } from 'vitest';

import { formatMessageCostUsd, resolveMessageCost } from './resolveMessageCost';

describe('resolveMessageCost', () => {
  it('prefers usage.cost over legacy metadata.cost', () => {
    expect(resolveMessageCost({ cost: 0.42 } as ModelUsage, { cost: 1.5 })).toBe(0.42);
  });

  it('falls back to metadata.cost', () => {
    expect(resolveMessageCost(undefined, { cost: 0.15 })).toBe(0.15);
  });

  it('returns undefined when missing', () => {
    expect(resolveMessageCost(undefined, undefined)).toBeUndefined();
  });

  it('ignores non-finite values', () => {
    expect(resolveMessageCost({ cost: Number.NaN } as ModelUsage, undefined)).toBeUndefined();
    expect(resolveMessageCost(undefined, { cost: Number.POSITIVE_INFINITY })).toBeUndefined();
  });
});

describe('formatMessageCostUsd', () => {
  it('formats typical costs as π tokens', () => {
    // 0.37 raw USD × 25_000_000 CVC/USD ÷ 1000 = 9_250 π
    expect(formatMessageCostUsd(0.37)).toBe('9,250 π');
    expect(formatMessageCostUsd(1)).toBe('25,000 π');
  });

  it('keeps readable precision for small OpenRouter charges', () => {
    // 0.00015 × 25_000 = 3.75 π
    expect(formatMessageCostUsd(0.00015)).toBe('3.75 π');
    expect(formatMessageCostUsd(0.0042)).toBe('105 π');
  });

  it('rounds large π amounts for display', () => {
    expect(formatMessageCostUsd(0.12)).toBe('3,000 π');
    expect(formatMessageCostUsd(1.23)).toBe('30,750 π');
  });
});
