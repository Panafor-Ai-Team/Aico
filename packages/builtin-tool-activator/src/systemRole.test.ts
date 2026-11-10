import { describe, expect, it } from 'vitest';

import { systemPrompt } from './systemRole';

describe('activator systemPrompt', () => {
  it('sends already-connected services to activateTools instead of re-connecting or web search', () => {
    expect(systemPrompt).toContain('Already-connected services come first');
    expect(systemPrompt).toContain("never use web search to look up the user's own account data");
  });

  it('does not route GitHub through the Market OAuth flow', () => {
    const marketLine = systemPrompt
      .split('\n')
      .find((line) => line.includes('OAuth services offered by'));
    expect(marketLine).toBeDefined();
    expect(marketLine).not.toMatch(/GitHub|Twitter/);
  });
});
