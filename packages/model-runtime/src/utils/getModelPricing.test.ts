import { beforeEach, describe, expect, it, vi } from 'vitest';

const loadModelsMock = vi.hoisted(() => vi.fn());

vi.mock('@lobechat/business-model-bank/model-config', () => ({
  loadModels: loadModelsMock,
}));

const { getModelPricing } = await import('./getModelPricing');

describe('getModelPricing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadModelsMock.mockResolvedValue([
      {
        id: 'gpt-4o',
        pricing: {
          units: [{ name: 'textInput', rate: 2.5, strategy: 'fixed', unit: 'millionTokens' }],
        },
        providerId: 'openai',
      },
      {
        id: 'gpt-4o',
        pricing: {
          units: [{ name: 'textInput', rate: 3, strategy: 'fixed', unit: 'millionTokens' }],
        },
        providerId: 'other-provider',
      },
    ]);
  });

  it('should use injected LobeHub pricing before same-id fallback pricing', async () => {
    loadModelsMock.mockResolvedValue([
      {
        id: 'injected-only-model',
        pricing: {
          units: [{ name: 'textInput', rate: 2.5, strategy: 'fixed', unit: 'millionTokens' }],
        },
        providerId: 'openai',
      },
      {
        id: 'injected-only-model',
        pricing: {
          units: [{ name: 'textInput', rate: 0.5, strategy: 'fixed', unit: 'millionTokens' }],
        },
        providerId: 'lobehub',
      },
    ]);

    const result = await getModelPricing('injected-only-model', 'lobehub');

    expect(result).toEqual({
      units: [{ name: 'textInput', rate: 0.5, strategy: 'fixed', unit: 'millionTokens' }],
    });
  });

  it('should propagate loadModels errors instead of falling back to static defaults', async () => {
    loadModelsMock.mockRejectedValue(new Error('model config missing'));

    await expect(getModelPricing('injected-only-model', 'lobehub')).rejects.toThrow(
      'model config missing',
    );
  });

  it('should use provider pricing when the provider match exists', async () => {
    const result = await getModelPricing('gpt-4o', 'openai');

    expect(result).toEqual({
      units: [{ name: 'textInput', rate: 2.5, strategy: 'fixed', unit: 'millionTokens' }],
    });
  });

  it('marks the reported cost up by the platform multiplier', async () => {
    const result = await getModelPricing('gpt-4o', 'openai', {
      costMultiplierBp: 12_500,
      plan: 'aico',
      scope: 'personal',
    });

    expect(result?.units[0]).toMatchObject({ rate: 3.125 });
  });

  it('composes a per-model correction on top, so the cost chip matches the picker', async () => {
    const result = await getModelPricing('gpt-4o', 'openai', {
      costMultiplierBp: 12_500,
      modelCostMultiplierBp: { 'gpt-4o': 14_400 },
      plan: 'aico',
      scope: 'personal',
    });

    // 2.5 x (1.25 x 1.44) = 4.5
    expect(result?.units[0]).toMatchObject({ rate: 4.5 });
  });

  it('leaves another model untouched by an override', async () => {
    const result = await getModelPricing('gpt-4o', 'openai', {
      costMultiplierBp: 12_500,
      modelCostMultiplierBp: { 'some-other-model': 14_400 },
      plan: 'aico',
      scope: 'personal',
    });

    expect(result?.units[0]).toMatchObject({ rate: 3.125 });
  });

  it('should pass explicit pricing context to loadModels', async () => {
    await getModelPricing('gpt-4o', 'openai', { plan: 'premium', scope: 'personal' });

    expect(loadModelsMock).toHaveBeenCalledWith({
      pricingContext: { plan: 'premium', scope: 'personal' },
    });
  });
});
