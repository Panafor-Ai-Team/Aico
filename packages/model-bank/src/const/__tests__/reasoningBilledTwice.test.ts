import { describe, expect, it } from 'vitest';

import { isReasoningBilledTwice, REASONING_BILLED_TWICE_MODEL_IDS } from '../reasoningBilledTwice';

describe('reasoning billed twice', () => {
  it('flags the CheapVibeCode models whose measured charge counts reasoning twice', () => {
    expect(isReasoningBilledTwice('deepseek-v4.1-flash')).toBe(true);
    expect(isReasoningBilledTwice('mimo-v2.5')).toBe(true);
    expect(REASONING_BILLED_TWICE_MODEL_IDS).toEqual(['deepseek-v4.1-flash', 'mimo-v2.5']);
  });

  it('does not flag models that bill at the published coefficient', () => {
    // glm-5.3-flash has the same reasoning field but bills at its published x0.3.
    expect(isReasoningBilledTwice('glm-5.3-flash')).toBe(false);
    expect(isReasoningBilledTwice(undefined)).toBe(false);
    expect(isReasoningBilledTwice('')).toBe(false);
  });
});
