/**
 * @vitest-environment happy-dom
 */
import { BRANDING_PROVIDER } from '@lobechat/business-const';
import { act, renderHook } from '@testing-library/react';
import type { TFunction } from 'i18next';
import type { Pricing } from 'model-bank';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { EnabledProviderWithModels } from '@/types/aiProvider';

import { useModelDetailPanel } from './useModelDetailPanel';

const {
  globalState,
  updateExpandedKeysMock,
  useBusinessModelPricingMock,
  useEnabledChatModelsMock,
} = vi.hoisted(() => ({
  globalState: {
    status: {
      modelDetailPanelExpandedKeys: ['pricing'],
    },
    updateModelDetailPanelExpandedKeys: vi.fn(),
  },
  updateExpandedKeysMock: vi.fn(),
  useBusinessModelPricingMock: vi.fn(),
  useEnabledChatModelsMock: vi.fn(),
}));

vi.mock('@/hooks/useEnabledChatModels', () => ({
  useEnabledChatModels: useEnabledChatModelsMock,
}));

vi.mock('@/business/client/hooks/useBusinessModelPricing', () => ({
  useBusinessModelPricing: useBusinessModelPricingMock,
}));

vi.mock('@/store/global', () => ({
  useGlobalStore: (selector: (state: typeof globalState) => unknown) => selector(globalState),
}));

vi.mock('@/store/global/selectors', () => ({
  systemStatusSelectors: {
    modelDetailPanelExpandedKeys: (state: typeof globalState) =>
      state.status.modelDetailPanelExpandedKeys,
  },
}));

const translations: Record<string, string> = {
  'ModelSwitchPanel.detail.pricing.credits.input': 'Input {{amount}} π/M tokens',
  'ModelSwitchPanel.detail.pricing.credits.millionTokens': 'π/M tokens',
  'ModelSwitchPanel.detail.pricing.credits.second': 'π/s',
  'ModelSwitchPanel.detail.pricing.credits.video': 'π/video',
  'ModelSwitchPanel.detail.pricing.credits.output': 'Output {{amount}} π/M tokens',
  'ModelSwitchPanel.detail.pricing.credits.perImage': '~ {{amount}} π / image',
  'ModelSwitchPanel.detail.pricing.credits.perVideo': '~ {{amount}} π / video',
};

const t = ((key: string, options?: Record<string, string>) => {
  const template = translations[key] ?? options?.defaultValue ?? key;

  return template.replaceAll(/\{\{(\w+)\}\}/g, (_, name) => options?.[name] ?? '');
}) as TFunction<'components'>;

const basePricing = {
  currency: 'USD',
  units: [
    { name: 'textInput', rate: 5, strategy: 'fixed', unit: 'millionTokens' },
    { name: 'textOutput', rate: 25, strategy: 'fixed', unit: 'millionTokens' },
  ],
} as Pricing;

const discountedPricing = {
  currency: 'USD',
  units: [
    { name: 'textInput', originalRate: 5, rate: 2.5, strategy: 'fixed', unit: 'millionTokens' },
    { name: 'textOutput', originalRate: 25, rate: 12.5, strategy: 'fixed', unit: 'millionTokens' },
    {
      name: 'textInput_cacheRead',
      originalRate: 1,
      rate: 0.3,
      strategy: 'fixed',
      unit: 'millionTokens',
    },
  ],
} as Pricing;

const unitPricing = {
  currency: 'USD',
  units: [
    {
      name: 'imageGeneration',
      strategy: 'tiered',
      tiers: [{ originalRate: 0.05, rate: 0.02, upTo: 'infinity' }],
      unit: 'image',
    },
    {
      lookup: { originalPrices: { standard: 0.5 }, prices: { standard: 0.3 } },
      name: 'videoGeneration',
      strategy: 'lookup',
      unit: 'video',
    },
  ],
} as Pricing;

const createEnabledList = (
  provider: string,
  pricing: Pricing,
  overrides: Record<string, unknown> = {},
): EnabledProviderWithModels[] => [
  {
    children: [
      {
        abilities: {},
        contextWindowTokens: 1_000_000,
        displayName: 'Test Model',
        id: 'test-model',
        pricing,
        type: 'chat',
        ...overrides,
      } as any,
    ],
    id: provider,
    name: provider,
    source: 'builtin',
  },
];

const renderModelDetailPanelHook = (
  params: Partial<Parameters<typeof useModelDetailPanel>[0]> = {},
) =>
  renderHook(() =>
    useModelDetailPanel({
      enabledList: createEnabledList(BRANDING_PROVIDER, basePricing),
      modelId: 'test-model',
      provider: BRANDING_PROVIDER,
      t,
      ...params,
    }),
  );

describe('useModelDetailPanel', () => {
  beforeEach(() => {
    globalState.status.modelDetailPanelExpandedKeys = ['pricing'];
    globalState.updateModelDetailPanelExpandedKeys = updateExpandedKeysMock;
    updateExpandedKeysMock.mockReset();
    useEnabledChatModelsMock.mockReturnValue([]);
    useBusinessModelPricingMock.mockReturnValue(({ pricing }: { pricing?: Pricing }) => pricing);
  });

  it('formats managed and branding providers in π tokens', () => {
    useBusinessModelPricingMock.mockReturnValue(
      ({ pricing, model, provider }: { model?: string; pricing?: Pricing; provider?: string }) =>
        provider === BRANDING_PROVIDER && model === 'test-model' ? discountedPricing : pricing,
    );

    const { result } = renderModelDetailPanelHook();

    // $2.5 / $5 / $0.3 / $1 → coefficient × · π (1× ≈ 1,000 π/M)
    expect(result.current.isCreditPricing).toBe(true);
    expect(result.current.formatPrice?.input).toEqual({
      current: '62.5× · 62,500',
      original: '125× · 125,000',
    });
    expect(result.current.formatPrice?.output).toEqual({
      current: '312.5× · 312,500',
      original: '625× · 625,000',
    });
    expect(result.current.formatPrice?.cachedInput).toEqual({
      current: '7.5× · 7,500',
      original: '25× · 25,000',
    });
    expect(result.current.hasCachedInputPricing).toBe(true);
    expect(result.current.getUnitPriceSuffix('millionTokens')).toBe(' π/M tokens');
    expect(result.current.getUnitPriceSuffix('video')).toBe(' π/video');
    expect(result.current.getUnitPriceSuffix('second')).toBe(' π/s');
  });

  it('also formats openrouter managed catalog prices with coefficient + π', () => {
    const { result } = renderModelDetailPanelHook({
      enabledList: createEnabledList('openrouter', basePricing),
      provider: 'openrouter',
    });

    expect(result.current.isCreditPricing).toBe(true);
    expect(result.current.formatPrice?.input).toEqual({ current: '125× · 125,000' });
    expect(result.current.getUnitPriceSuffix('millionTokens')).toBe(' π/M tokens');
  });

  it('uses dollar unit suffixes for non-managed providers', () => {
    const { result } = renderModelDetailPanelHook({
      enabledList: createEnabledList('openai', unitPricing),
      provider: 'openai',
    });

    expect(result.current.isCreditPricing).toBe(false);
    expect(result.current.getUnitPriceSuffix('video')).toBe('/video');
    expect(result.current.getUnitPriceSuffix('second')).toBe('/s');
    expect(result.current.getUnitPriceSuffix('megapixel')).toBe('/MP');
  });

  it('formats original unit prices for tiered and lookup units in π', () => {
    const { result } = renderModelDetailPanelHook({
      enabledList: createEnabledList(BRANDING_PROVIDER, unitPricing),
    });

    // $0.02 / $0.05 → 500 / 1,250 π; $0.30 / $0.50 → 7,500 / 12,500 π
    expect(result.current.formatUnitPrice(unitPricing.units[0])).toEqual({
      current: '500',
      original: '1,250',
    });
    expect(result.current.formatUnitPrice(unitPricing.units[1])).toEqual({
      current: '7,500',
      original: '12,500',
    });
  });

  it('uses the enabled model list hook when no list is provided', () => {
    useEnabledChatModelsMock.mockReturnValue(
      createEnabledList(BRANDING_PROVIDER, basePricing, {
        abilities: { reasoning: true },
      }),
    );

    const { result } = renderModelDetailPanelHook({ enabledList: undefined });

    expect(result.current.model?.id).toBe('test-model');
    expect(result.current.contextWindowLabel).toBe('1M tokens');
    expect(result.current.hasAbilities).toBe(true);
  });

  it('falls back to the model-level approximatePricePerImage for token-priced generators', () => {
    // OpenRouter prices Gemini-family image generators on imageOutput/millionTokens,
    // so pricing.approximatePricePerImage is never set at the source — only the
    // top-level field computed by resolveImageSinglePrice (normalizeImageModel).
    const tokenPricedImagePricing = {
      currency: 'USD',
      units: [{ name: 'imageOutput', rate: 40, strategy: 'fixed', unit: 'millionTokens' }],
    } as Pricing;

    const { result } = renderModelDetailPanelHook({
      enabledList: createEnabledList('openrouter', tokenPricedImagePricing, {
        approximatePricePerImage: 0.05,
      }),
      pricingMode: 'image',
      provider: 'openrouter',
    });

    // $0.05 → 1,250 π
    expect(result.current.approximatePriceLabel).toBe('~ 1,250 π / image');
  });

  it('prefers an explicit pricing.approximatePricePerImage when the model has no top-level field', () => {
    const explicitPricing = {
      approximatePricePerImage: 0.04,
      currency: 'USD',
      units: [{ name: 'imageGeneration', rate: 0.04, strategy: 'fixed', unit: 'image' }],
    } as Pricing;

    const { result } = renderModelDetailPanelHook({
      enabledList: createEnabledList('openrouter', explicitPricing),
      pricingMode: 'image',
      provider: 'openrouter',
    });

    expect(result.current.approximatePriceLabel).toBe('~ 1,000 π / image');
  });

  it('updates expanded detail sections', () => {
    const { result } = renderModelDetailPanelHook();

    act(() => {
      result.current.handleExpandedChange(['abilities']);
    });

    expect(updateExpandedKeysMock).toHaveBeenCalledWith(['abilities']);
  });
});
