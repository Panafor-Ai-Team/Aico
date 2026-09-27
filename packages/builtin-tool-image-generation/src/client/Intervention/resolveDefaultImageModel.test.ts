import { describe, expect, it } from 'vitest';

import {
  type ImageModelOption,
  resolveDefaultImageModelOption,
  toImageModelSelectOptions,
} from './resolveDefaultImageModel';

const option = (provider: string, model: string): ImageModelOption => ({
  displayName: model,
  model,
  provider,
  providerName: provider,
});

describe('resolveDefaultImageModelOption', () => {
  it('defaults to gpt-image-2 over Muse even when Muse is listed under OpenRouter', () => {
    const options = [
      option('openrouter', 'meta/muse-image'),
      option('openrouter', 'some/other-image-model'),
      option('cheapvibecode', 'gpt-image-2'),
    ];

    expect(resolveDefaultImageModelOption(options)?.model).toBe('gpt-image-2');
  });

  it('defaults to OpenRouter vendor-prefixed openai/gpt-image-2 over Muse', () => {
    const options = [
      option('openrouter', 'meta/muse-image'),
      option('openrouter', 'openai/gpt-image-2'),
      option('openrouter', 'some/other-image-model'),
    ];

    expect(resolveDefaultImageModelOption(options)?.model).toBe('openai/gpt-image-2');
  });

  it('maps an assistant request for bare gpt-image-2 onto openai/gpt-image-2', () => {
    const options = [
      option('openrouter', 'meta/muse-image'),
      option('openrouter', 'openai/gpt-image-2'),
    ];

    expect(
      resolveDefaultImageModelOption(options, { model: 'gpt-image-2', provider: 'openrouter' })
        ?.model,
    ).toBe('openai/gpt-image-2');
  });

  it('defaults to Muse when gpt-image-2 is unavailable', () => {
    const options = [
      option('openrouter', 'some/other-image-model'),
      option('openrouter', 'meta/muse-image'),
    ];

    expect(resolveDefaultImageModelOption(options)?.model).toBe('meta/muse-image');
  });

  it('matches the pinned model through its synthesized :image sibling', () => {
    const options = [
      option('openrouter', 'some/other-image-model'),
      option('openrouter', 'gpt-image-2:image'),
    ];

    expect(resolveDefaultImageModelOption(options)?.model).toBe('gpt-image-2:image');
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

describe('toImageModelSelectOptions', () => {
  it('labels options with the model display name only, never the managed provider', () => {
    const options: ImageModelOption[] = [
      {
        displayName: 'Nano Banana Pro',
        model: 'google/gemini-3-pro-image-preview',
        provider: 'openrouter',
        providerName: 'OpenRouter',
      },
      { displayName: 'GPT Image 2', model: 'gpt-image-2', provider: 'aico', providerName: 'aico' },
    ];

    const selectOptions = toImageModelSelectOptions(options);

    expect(selectOptions.map((o) => o.label)).toEqual(['Nano Banana Pro', 'GPT Image 2']);
    for (const { label } of selectOptions) {
      expect(label).not.toMatch(/openrouter|aico/i);
    }
    expect(selectOptions[0].value).toBe('openrouter/google/gemini-3-pro-image-preview');
  });
});
