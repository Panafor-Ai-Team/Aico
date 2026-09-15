import { describe, expect, it } from 'vitest';

import type { Pricing } from './types/aiModel';
import {
  applyPricingMultiplier,
  composeMultiplierBp,
  resolveModelSearchDefaultSettings,
  resolveSearchDecision,
} from './utils';

describe('resolveSearchDecision', () => {
  it.each([
    {
      expected: { application: false, model: false },
      input: { modelSearchImpl: 'internal' as const, searchMode: 'off' as const },
      name: 'disables every search route when search is off',
    },
    {
      expected: { application: false, model: true },
      input: {
        modelSearchImpl: 'params' as const,
        searchMode: 'on' as const,
        useModelBuiltinSearch: true,
      },
      name: 'uses model search when supported and selected',
    },
    {
      expected: { application: true, model: false },
      input: {
        modelSearchImpl: 'params' as const,
        searchMode: 'on' as const,
        useModelBuiltinSearch: false,
      },
      name: 'uses application search when model search is not selected',
    },
    {
      expected: { application: true, model: false },
      input: { searchMode: 'on' as const, useModelBuiltinSearch: true },
      name: 'falls back to application search when native search is unsupported',
    },
    {
      expected: { application: false, model: true },
      input: { modelSearchImpl: 'internal' as const, searchMode: 'on' as const },
      name: 'always uses internal model search while search is enabled',
    },
    {
      expected: { application: false, model: true },
      input: {
        modelSearchImpl: 'tool' as const,
        searchMode: 'on' as const,
        useModelBuiltinSearch: false,
      },
      name: 'uses tool-based native search without requiring the builtin toggle',
    },
    {
      expected: { application: false, model: true },
      input: {
        providerSearchMode: 'tool' as const,
        searchMode: 'auto' as const,
        useModelBuiltinSearch: false,
      },
      name: 'uses provider tool search (e.g. SuperGrok) without the builtin toggle',
    },
    {
      expected: { application: false, model: true },
      input: { providerSearchMode: 'internal' as const, searchMode: 'on' as const },
      name: 'always uses internal provider search while search is enabled',
    },
  ])('$name', ({ expected, input }) => {
    const result = resolveSearchDecision(input);

    expect(result.useModelSearch).toBe(expected.model);
    expect(result.useApplicationBuiltinSearchTool).toBe(expected.application);
    expect(result.enabledSearch).toBe(input.searchMode !== 'off');
  });
});

describe('resolveModelSearchDefaultSettings', () => {
  it('keeps model-specific internal search defaults', () => {
    expect(resolveModelSearchDefaultSettings('openai', 'gpt-4o-search-preview')).toEqual({
      searchImpl: 'internal',
    });
  });

  it('falls back to params for unknown providers', () => {
    expect(resolveModelSearchDefaultSettings('custom-provider', 'remote-model')).toEqual({
      searchImpl: 'params',
    });
  });

  it('defaults xAI remote models to tool-based Live Search', () => {
    expect(resolveModelSearchDefaultSettings('xai', 'grok-remote')).toEqual({
      searchImpl: 'tool',
    });
  });
});

describe('applyPricingMultiplier', () => {
  const bp = 12_000; // 1.20x

  it('scales fixed token rates and their display mirror', () => {
    const pricing: Pricing = {
      units: [
        { name: 'textInput', originalRate: 4, rate: 3, strategy: 'fixed', unit: 'millionTokens' },
      ],
    };

    expect(applyPricingMultiplier(pricing, bp).units).toEqual([
      { name: 'textInput', originalRate: 4.8, rate: 3.6, strategy: 'fixed', unit: 'millionTokens' },
    ]);
  });

  it('scales per-image rates the same way as token rates', () => {
    const pricing: Pricing = {
      approximatePricePerImage: 0.01,
      units: [{ name: 'imageGeneration', rate: 0.01, strategy: 'fixed', unit: 'image' }],
    };

    const marked = applyPricingMultiplier(pricing, bp);

    expect(marked.approximatePricePerImage).toBeCloseTo(0.012, 10);
    expect((marked.units[0] as { rate: number }).rate).toBeCloseTo(0.012, 10);
  });

  it('scales per-second video rates', () => {
    const pricing: Pricing = {
      approximatePricePerVideo: 5,
      units: [{ name: 'videoGeneration', rate: 0.5, strategy: 'fixed', unit: 'second' }],
    };

    const marked = applyPricingMultiplier(pricing, bp);

    expect(marked.approximatePricePerVideo).toBeCloseTo(6, 10);
    expect((marked.units[0] as { rate: number }).rate).toBeCloseTo(0.6, 10);
  });

  it('scales every tier of a tiered unit', () => {
    const pricing: Pricing = {
      units: [
        {
          name: 'textInput',
          strategy: 'tiered',
          tiers: [
            { rate: 1, upTo: 128_000 },
            { originalRate: 4, rate: 2, upTo: 'infinity' },
          ],
          unit: 'millionTokens',
        },
      ],
    };

    expect((applyPricingMultiplier(pricing, bp).units[0] as { tiers: unknown[] }).tiers).toEqual([
      { rate: 1.2, upTo: 128_000 },
      { originalRate: 4.8, rate: 2.4, upTo: 'infinity' },
    ]);
  });

  it('scales every entry of a lookup price table, including original prices', () => {
    const pricing: Pricing = {
      units: [
        {
          lookup: {
            originalPrices: { '1024x1024': 0.05 },
            prices: { '1024x1024': 0.04, '1792x1024': 0.08 },
            pricingParams: ['size'],
          },
          name: 'imageGeneration',
          strategy: 'lookup',
          unit: 'image',
        },
      ],
    };

    const unit = applyPricingMultiplier(pricing, bp).units[0] as {
      lookup: { originalPrices: Record<string, number>; prices: Record<string, number> };
    };

    expect(unit.lookup.prices['1024x1024']).toBeCloseTo(0.048, 10);
    expect(unit.lookup.prices['1792x1024']).toBeCloseTo(0.096, 10);
    expect(unit.lookup.originalPrices['1024x1024']).toBeCloseTo(0.06, 10);
  });

  it('returns pricing untouched at 1.0x and for invalid multipliers', () => {
    const pricing: Pricing = {
      units: [{ name: 'textInput', rate: 3, strategy: 'fixed', unit: 'millionTokens' }],
    };

    expect(applyPricingMultiplier(pricing, 10_000)).toBe(pricing);
    expect(applyPricingMultiplier(pricing, 0)).toBe(pricing);
    expect(applyPricingMultiplier(pricing, undefined)).toBe(pricing);
    expect(applyPricingMultiplier(undefined, bp)).toBeUndefined();
  });
});

describe('composeMultiplierBp', () => {
  it('multiplies the platform rate by the per-model correction', () => {
    expect(composeMultiplierBp(12_500, 14_400)).toBe(18_000); // 1.25x * 1.44x
    expect(composeMultiplierBp(12_000, 5_000)).toBe(6_000); // an override may discount
  });

  it('returns the platform rate untouched when no override applies', () => {
    expect(composeMultiplierBp(12_500, 10_000)).toBe(12_500);
    expect(composeMultiplierBp(12_500, undefined)).toBe(12_500);
    expect(composeMultiplierBp(12_500, null)).toBe(12_500);
  });

  it('falls back to 1.00x rather than zeroing a price on bad input', () => {
    expect(composeMultiplierBp(undefined, undefined)).toBe(10_000);
    expect(composeMultiplierBp(0, 12_000)).toBe(12_000);
    expect(composeMultiplierBp(12_000, Number.NaN)).toBe(12_000);
  });

  it('rounds the composed rate to whole basis points', () => {
    // 1.25x * 1.443x = 1.80375x -> 18038 bp, one rounding, one price path.
    expect(composeMultiplierBp(12_500, 14_430)).toBe(18_038);
  });
});
