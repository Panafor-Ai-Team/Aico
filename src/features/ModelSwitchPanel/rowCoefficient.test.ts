import { BRANDING_PROVIDER } from '@lobechat/business-const';
import type { Pricing } from 'model-bank';
import { describe, expect, it } from 'vitest';

import { formatTokenCoefficient, isolateLtr } from '@/features/AicoBilling/piToken';

import { getRowCoefficient } from './rowCoefficient';

const fixed = (input: number, output = input) =>
  ({
    currency: 'USD',
    units: [
      { name: 'textInput', rate: input, strategy: 'fixed', unit: 'millionTokens' },
      { name: 'textOutput', rate: output, strategy: 'fixed', unit: 'millionTokens' },
    ],
  }) as Pricing;

describe('getRowCoefficient', () => {
  it('shows the same coefficient the details popup shows', () => {
    // 0.16 USD/M is 4× at the default rate.
    expect(getRowCoefficient(fixed(0.16), BRANDING_PROVIDER, 'x')?.label).toBe(
      isolateLtr(formatTokenCoefficient(0.16)),
    );
    expect(getRowCoefficient(fixed(0.16), BRANDING_PROVIDER, 'x')?.label).toBe(isolateLtr('4×'));
  });

  it('shows input and output separately when they differ', () => {
    expect(getRowCoefficient(fixed(0.04, 0.16), BRANDING_PROVIDER, 'x')?.label).toBe(
      isolateLtr('↑1× ↓4×'),
    );
  });

  it('shows nothing for direct providers, which keep dollar pricing', () => {
    expect(getRowCoefficient(fixed(5, 25), 'openai', 'x')).toBeUndefined();
  });

  it('shows nothing without a token price (image, video, embeddings)', () => {
    const image = {
      currency: 'USD',
      units: [{ name: 'imageGeneration', rate: 0.04, strategy: 'fixed', unit: 'image' }],
    } as Pricing;
    expect(getRowCoefficient(image, BRANDING_PROVIDER, 'x')).toBeUndefined();
    expect(getRowCoefficient(undefined, BRANDING_PROVIDER, 'x')).toBeUndefined();
  });

  it('flags models CVC charges more than the published coefficient', () => {
    expect(getRowCoefficient(fixed(0.012), BRANDING_PROVIDER, 'deepseek-v4.1-flash')).toEqual({
      billedTwice: true,
      label: isolateLtr('0.3×'),
    });
    expect(getRowCoefficient(fixed(0.012), BRANDING_PROVIDER, 'glm-5.3-flash')?.billedTwice).toBe(
      false,
    );
  });
});
