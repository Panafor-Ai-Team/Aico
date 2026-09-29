import { computeImageCost } from '@lobechat/model-runtime/computeImageCost';
import { computeVideoCost } from '@lobechat/model-runtime/computeVideoCost';
import type { FixedPricingUnit, Pricing } from 'model-bank';

import { applyBusinessModelPricing } from '@/business/client/hooks/useBusinessModelPricing';

export interface PricedGenerationModel {
  approximatePricePerImage?: number;
  approximatePricePerVideo?: number;
  id: string;
  pricing?: Pricing;
}

const positive = (value: number | undefined) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;

/** `text` vs `image` for CheapVibeCode (and similar) lookup pricing tables. */
export const resolveVideoCostSource = (params: Record<string, unknown>): 'image' | 'text' => {
  if (typeof params.imageUrl === 'string' && params.imageUrl.trim()) return 'image';
  if (
    Array.isArray(params.imageUrls) &&
    params.imageUrls.some((url) => typeof url === 'string' && url.trim())
  ) {
    return 'image';
  }
  return 'text';
};

const imageInputCount = (params: Record<string, unknown>): number => {
  if (typeof params.imageUrl === 'string' && params.imageUrl.trim()) return 1;
  if (Array.isArray(params.imageUrls)) {
    return params.imageUrls.filter((url) => typeof url === 'string' && url.trim()).length;
  }
  return 0;
};

/**
 * USD cost of an image request, priced like the server charges it; falls back
 * to the catalog's per-image estimate for token-priced models.
 */
export const estimateImageGenerationCostUsd = ({
  imageNum,
  model,
  params,
  provider,
}: {
  imageNum: number;
  model: PricedGenerationModel;
  params: Record<string, unknown>;
  provider: string;
}): number | undefined => {
  const pricing = applyBusinessModelPricing({ model: model.id, pricing: model.pricing, provider });
  const exact = pricing
    ? positive(computeImageCost(pricing, params, imageNum)?.totalCost)
    : undefined;
  if (exact) return exact;

  const perImage = positive(model.approximatePricePerImage ?? pricing?.approximatePricePerImage);
  return perImage ? perImage * imageNum : undefined;
};

/**
 * USD cost of a video request for its duration / resolution / source (text vs
 * image); falls back to the catalog's per-video estimate for token-priced models.
 */
export const estimateVideoGenerationCostUsd = ({
  model,
  params,
  provider,
}: {
  model: PricedGenerationModel;
  params: Record<string, unknown>;
  provider: string;
}): number | undefined => {
  const pricing = applyBusinessModelPricing({ model: model.id, pricing: model.pricing, provider });
  const source = resolveVideoCostSource(params);
  const costParams = { ...params, source };
  const exact = pricing ? positive(computeVideoCost(pricing, 0, costParams)?.totalCost) : undefined;

  if (exact !== undefined) {
    const images = imageInputCount(params);
    const imageInput = pricing?.units.find(
      (unit): unit is FixedPricingUnit =>
        unit.name === 'imageInput' && unit.strategy === 'fixed' && unit.unit === 'image',
    );
    const inputFee = source === 'image' && images > 0 && imageInput ? imageInput.rate * images : 0;
    return exact + inputFee;
  }

  return positive(model.approximatePricePerVideo ?? pricing?.approximatePricePerVideo);
};
