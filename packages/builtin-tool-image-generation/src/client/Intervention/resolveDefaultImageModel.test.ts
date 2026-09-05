import { describe, expect, it } from 'vitest';

import { type ImageModelOption, resolveDefaultImageModelOption } from './resolveDefaultImageModel';

const option = (provider: string, model: string): ImageModelOption => ({
  displayName: model,
  model,
  provider,
  providerName: provider,
});

describe('resolveDefaultImageModelOption', () => {
  it('defaults to the pinned OpenRouter model instead of catalog order', () => {
    const options = [
      option('openrouter', 'some/other-image-model'),
      option('openrouter', 'meta/muse-image'),
    ];

    expect(resolveDefaultImageModelOption(options)?.model).toBe('meta/muse-image');
  });

  it('matches the pinned model through its synthesized :image sibling', () => {
    const options = [
      option('openrouter', 'some/other-image-model'),
      option('openrouter', 'meta/muse-image:image'),
    ];

    expect(resolveDefaultImageModelOption(options)?.model).toBe('meta/muse-image:image');
  });

  it('honours a model the assistant explicitly requested', () => {
    const options = [
      option('openrouter', 'meta/muse-image'),
      option('openrouter', 'some/other-image-model'),
    ];

    expect(
      resolveDefaultImageModelOption(options, { model: 'some/other-image-model' })?.model,
    ).toBe('some/other-image-model');
  });

  it('ignores a requested model the account does not have', () => {
    const options = [option('openrouter', 'meta/muse-image')];

    expect(resolveDefaultImageModelOption(options, { model: 'not/available' })?.model).toBe(
      'meta/muse-image',
    );
  });

  it('falls back to the first available model when the pinned default is missing', () => {
    const options = [option('fal', 'flux/dev'), option('fal', 'flux/pro')];

    expect(resolveDefaultImageModelOption(options)?.model).toBe('flux/dev');
  });

  it('returns nothing when the account has no image model', () => {
    expect(resolveDefaultImageModelOption([])).toBeUndefined();
  });
});
