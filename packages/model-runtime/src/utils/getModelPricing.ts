import type { LobeDefaultAiModelListItem, Pricing } from 'model-bank';
import { applyPricingMultiplier, composeMultiplierBp } from 'model-bank';

import type { ModelPricingContext } from '../types';

interface BusinessModelConfigModule {
  loadModels: (options?: {
    pricingContext?: ModelPricingContext;
  }) => Promise<LobeDefaultAiModelListItem[]>;
}

/**
 * 1. First try to get pricing from the specified provider
 * 2. If not found, try to get pricing from other providers with the same model name
 *
 * TODO: Add a fallback provider priority list. When no provider is specified,
 * first try official providers, then other providers. Same applies to getFallbackModelProperty
 */
export async function getModelPricing(
  model: string,
  provider?: string,
  pricingContext?: ModelPricingContext,
): Promise<Pricing | undefined> {
  const { loadModels } =
    (await import('@lobechat/business-model-bank/model-config')) as BusinessModelConfigModule;
  const models = await loadModels(pricingContext ? { pricingContext } : undefined);

  // Managed Aico traffic resells upstream capacity: the caller passes the
  // platform multiplier so every cost derived from this pricing is the billed
  // amount. Raw rates stay server-side.
  //
  // A per-model correction (AICO-187) is composed on top, because some upstream
  // models bill above their published coefficient and the picker applies the
  // same pair — reporting a cost without it would contradict the listed price.
  const modelBp = pricingContext?.modelCostMultiplierBp?.[model];
  const withMultiplier = (pricing: Pricing): Pricing => {
    if (!pricingContext?.costMultiplierBp && !modelBp) return pricing;
    return applyPricingMultiplier(
      pricing,
      composeMultiplierBp(pricingContext?.costMultiplierBp, modelBp),
    );
  };

  // 1. First try to get pricing from the specified provider
  if (provider) {
    const exactMatch = models.find((m) => m.id === model && m.providerId === provider);

    if (exactMatch?.pricing) {
      return withMultiplier(exactMatch.pricing);
    }
  }

  // 2. If not found, try to get pricing from other providers with the same model name
  const fallbackMatch = models.find((m) => m.id === model);

  if (fallbackMatch?.pricing) {
    return withMultiplier(fallbackMatch.pricing);
  }

  // 3. Return undefined if no pricing information is found
  return undefined;
}
