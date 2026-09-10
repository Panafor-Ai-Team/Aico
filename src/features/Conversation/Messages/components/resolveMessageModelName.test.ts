import { describe, expect, it } from 'vitest';

import { resolveCostModelId, resolveMessageModelName } from './resolveMessageModelName';

describe('resolveCostModelId', () => {
  it('names the model the Auto router picked, not the alias', () => {
    expect(
      resolveCostModelId('openrouter/auto', { cost: 0.002, resolvedModel: 'openai/gpt-5' }),
    ).toBe('openai/gpt-5');
  });

  it('keeps the requested model when the provider reported no router pick', () => {
    expect(resolveCostModelId('openai/gpt-5', { cost: 0.002 })).toBe('openai/gpt-5');
  });

  it('ignores a non-string resolvedModel', () => {
    expect(resolveCostModelId('openrouter/auto', { resolvedModel: 42 })).toBe('openrouter/auto');
  });

  it('tolerates missing metadata', () => {
    expect(resolveCostModelId('openrouter/auto', null)).toBe('openrouter/auto');
  });
});

describe('resolveMessageModelName', () => {
  it('prefers the model card display name', () => {
    expect(
      resolveMessageModelName({ displayName: 'GPT-5', model: 'gpt-5', provider: 'openai' }),
    ).toEqual({ name: 'GPT-5', showIcon: true });
  });

  it('falls back to the raw model id when the card is unknown', () => {
    expect(resolveMessageModelName({ model: 'gpt-5', provider: 'openai' })).toEqual({
      name: 'gpt-5',
      showIcon: true,
    });
  });

  it('uses the brand label and drops the icon for remote platform agents', () => {
    expect(resolveMessageModelName({ model: null, provider: 'openclaw' })).toEqual({
      name: 'OpenClaw',
      showIcon: false,
    });
  });

  it('keeps the real model for local CLI agents that report one', () => {
    expect(
      resolveMessageModelName({
        displayName: 'Claude Opus 4',
        model: 'claude-opus-4',
        provider: 'claude-code',
      }),
    ).toEqual({ name: 'Claude Opus 4', showIcon: true });
  });

  it('returns no name when the message has no model at all', () => {
    expect(resolveMessageModelName({ model: null, provider: null })).toEqual({
      name: undefined,
      showIcon: false,
    });
  });
});
