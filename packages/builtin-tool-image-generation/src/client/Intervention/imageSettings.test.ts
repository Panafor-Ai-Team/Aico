import type { ModelParamsSchema } from 'model-bank';
import { describe, expect, it } from 'vitest';

import { applyImageSettings, resolveImageSettingFields } from './imageSettings';

const gptImage2: ModelParamsSchema = {
  prompt: { default: '' },
  quality: { default: 'medium', enum: ['low', 'medium', 'high', 'auto'] },
  size: { default: 'auto', enum: ['auto', '1024x1024', '1536x1024'] },
};

const nanoBanana: ModelParamsSchema = {
  aspectRatio: { default: 'auto', enum: ['auto', '1:1', '16:9'] },
  prompt: { default: '' },
  resolution: { default: '1K', enum: ['1K', '2K'] },
};

describe('resolveImageSettingFields', () => {
  it('offers only the options the model has, set to its defaults', () => {
    expect(resolveImageSettingFields(gptImage2, undefined, {})).toEqual([
      { key: 'quality', options: ['low', 'medium', 'high', 'auto'], value: 'medium' },
      { key: 'size', options: ['auto', '1024x1024', '1536x1024'], value: 'auto' },
    ]);
    expect(resolveImageSettingFields(nanoBanana, undefined, {}).map((f) => f.key)).toEqual([
      'resolution',
      'aspectRatio',
    ]);
  });

  it("prefers the user's pick, then the assistant's request", () => {
    const fields = resolveImageSettingFields(
      gptImage2,
      { quality: 'high', size: '1536x1024' },
      { quality: 'low' },
    );

    expect(fields.find((f) => f.key === 'quality')?.value).toBe('low');
    expect(fields.find((f) => f.key === 'size')?.value).toBe('1536x1024');
  });

  it('drops values the newly selected model does not accept', () => {
    const fields = resolveImageSettingFields(
      nanoBanana,
      { resolution: '4K' },
      { aspectRatio: '3:2' },
    );

    expect(fields).toEqual([
      { key: 'resolution', options: ['1K', '2K'], value: '1K' },
      { key: 'aspectRatio', options: ['auto', '1:1', '16:9'], value: 'auto' },
    ]);
  });

  it('shows no pickers for prompt-only models', () => {
    expect(resolveImageSettingFields({ prompt: { default: '' } }, undefined, {})).toEqual([]);
  });
});

describe('applyImageSettings', () => {
  it('writes every picked value into the tool parameters', () => {
    const fields = resolveImageSettingFields(gptImage2, undefined, { quality: 'high' });

    expect(applyImageSettings({ seed: 7 }, fields)).toEqual({
      quality: 'high',
      seed: 7,
      size: 'auto',
    });
  });
});
