import { describe, expect, it } from 'vitest';

import { toLiveManagedModelId } from './llm';

describe('toLiveManagedModelId', () => {
  // A browser bundle resolves the managed gateway as OpenRouter, so it sends
  // OpenRouter's defaults even while CheapVibeCode is live.
  it("maps OpenRouter's default ids onto CheapVibeCode's", () => {
    expect(toLiveManagedModelId('openai/gpt-4o-mini', 'cheapvibecode')).toBe('glm-5.3-flash');
    expect(toLiveManagedModelId('deepseek/deepseek-chat-v3.1', 'cheapvibecode')).toBe(
      'deepseek-v4-flash',
    );
  });

  it('maps the other way after a switch back to OpenRouter', () => {
    expect(toLiveManagedModelId('glm-5.3-flash', 'openrouter')).toBe('openai/gpt-4o-mini');
  });

  it("leaves the live gateway's own ids and every other id alone", () => {
    expect(toLiveManagedModelId('glm-5.3-flash', 'cheapvibecode')).toBe('glm-5.3-flash');
    expect(toLiveManagedModelId('claude-opus-5-5', 'cheapvibecode')).toBe('claude-opus-5-5');
    expect(toLiveManagedModelId('openrouter/auto', 'cheapvibecode')).toBe('openrouter/auto');
  });
});
