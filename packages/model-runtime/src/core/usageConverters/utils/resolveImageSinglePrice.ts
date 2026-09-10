import type { Pricing, PricingUnit } from 'model-bank';

export interface ImageSinglePriceResult {
  approximatePrice?: number;
  price?: number;
}

const DEFAULT_REFERENCE_MP = (1024 * 1024) / 1_000_000;

/**
 * Gemini-family image models bill roughly this many output tokens per
 * generated image (documented default; actual usage varies by resolution).
 * Used only to turn a token-priced `imageOutput` rate into a rough per-image
 * estimate for display when no dedicated `imageGeneration` unit exists.
 */
export const DEFAULT_IMAGE_OUTPUT_TOKENS = 1290;

export const resolveImageSinglePrice = (pricing?: Pricing): ImageSinglePriceResult => {
  if (!pricing) return {};

  // Priority 1: Use approximate price if explicitly provided
  if (typeof pricing.approximatePricePerImage === 'number') {
    return { approximatePrice: pricing.approximatePricePerImage };
  }

  // Priority 2: Calculate exact price from pricing units
  const imageGenerationUnit = pricing.units.find((unit) => unit.name === 'imageGeneration');

  if (imageGenerationUnit) {
    if (imageGenerationUnit.strategy === 'fixed') {
      if (imageGenerationUnit.unit === 'image') {
        return { price: imageGenerationUnit.rate };
      }

      if (imageGenerationUnit.unit === 'megapixel') {
        return { price: imageGenerationUnit.rate * DEFAULT_REFERENCE_MP };
      }
    }

    // Lookup: show the lowest listed price as an approximate per-image amount.
    if (imageGenerationUnit.strategy === 'lookup') {
      const prices = Object.values(imageGenerationUnit.lookup.prices);
      if (prices.length > 0) return { approximatePrice: Math.min(...prices) };
    }
  }

  // Priority 3: token-priced generators (e.g. OpenRouter's Gemini image
  // models) live on imageOutput/millionTokens rather than imageGeneration.
  // Estimate a rough per-image cost so Create still shows *something* instead
  // of nothing; this is deliberately an approximation, never an exact price.
  const imageOutputUnit = pricing.units.find(
    // Predicate form so the result narrows to the fixed-rate variant; a plain
    // boolean callback leaves the union intact and `rate` unreachable.
    (unit): unit is Extract<PricingUnit, { strategy: 'fixed' }> =>
      unit.name === 'imageOutput' && unit.strategy === 'fixed',
  );
  if (imageOutputUnit && imageOutputUnit.unit === 'millionTokens') {
    return {
      approximatePrice: (imageOutputUnit.rate * DEFAULT_IMAGE_OUTPUT_TOKENS) / 1_000_000,
    };
  }

  return {};
};
