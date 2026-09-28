import type { Pricing } from 'model-bank';
import { describe, expect, it } from 'vitest';

import {
  estimateImageGenerationCostUsd,
  estimateVideoGenerationCostUsd,
} from './estimateGenerationCost';

describe('estimateImageGenerationCostUsd', () => {
  it('multiplies a fixed per-image price by the image count', () => {
    const pricing: Pricing = {
      units: [{ name: 'imageGeneration', rate: 0.04, strategy: 'fixed', unit: 'image' }],
    };

    expect(
      estimateImageGenerationCostUsd({
        imageNum: 3,
        model: { id: 'flux', pricing },
        params: {},
        provider: 'fal',
      }),
    ).toBeCloseTo(0.12);
  });

  it('falls back to the catalog per-image estimate for token-priced models', () => {
    expect(
      estimateImageGenerationCostUsd({
        imageNum: 2,
        model: { approximatePricePerImage: 0.05, id: 'gpt-image-2' },
        params: {},
        provider: 'openai',
      }),
    ).toBeCloseTo(0.1);
  });

  it('returns undefined when the model has no usable price', () => {
    expect(
      estimateImageGenerationCostUsd({
        imageNum: 1,
        model: { id: 'unknown' },
        params: {},
        provider: 'openai',
      }),
    ).toBeUndefined();
  });
});

describe('estimateVideoGenerationCostUsd', () => {
  it('prices per-second models by the requested duration', () => {
    const pricing: Pricing = {
      units: [{ name: 'videoGeneration', rate: 0.05, strategy: 'fixed', unit: 'second' }],
    };

    expect(
      estimateVideoGenerationCostUsd({
        model: { id: 'grok-imagine-video', pricing },
        params: { duration: 6 },
        provider: 'cheapvibecode',
      }),
    ).toBeCloseTo(0.3);
  });

  it('prices lookup models by the requested resolution', () => {
    const pricing: Pricing = {
      units: [
        {
          lookup: { prices: { '480p': 0.05, '720p': 0.1 }, pricingParams: ['resolution'] },
          name: 'videoGeneration',
          strategy: 'lookup',
          unit: 'second',
        },
      ],
    };

    const cost = (resolution: string) =>
      estimateVideoGenerationCostUsd({
        model: { id: 'video', pricing },
        params: { duration: 4, resolution },
        provider: 'openrouter',
      });

    expect(cost('480p')).toBeCloseTo(0.2);
    expect(cost('720p')).toBeCloseTo(0.4);
  });

  it('falls back to the catalog per-video estimate', () => {
    expect(
      estimateVideoGenerationCostUsd({
        model: { approximatePricePerVideo: 0.8, id: 'veo' },
        params: {},
        provider: 'openrouter',
      }),
    ).toBe(0.8);
  });
});
