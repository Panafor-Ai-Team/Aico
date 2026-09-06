import { describe, expect, it } from 'vitest';

import { resolveMessageModelName } from './resolveMessageModelName';

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
