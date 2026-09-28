import { computeImageCost } from '@lobechat/model-runtime/computeImageCost';
import { computeVideoCost } from '@lobechat/model-runtime/computeVideoCost';
import type { Pricing } from 'model-bank';

import { applyBusinessModelPricing } from '@/business/client/hooks/useBusinessModelPricing';

export interface PricedGenerationModel {
  approximatePricePerImage?: number;
  approximatePricePerVideo?: number;
  id: string;
  pricing?: Pricing;
}

const positive = (value: number | undefined) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;

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
 * USD cost of a video request for its duration / resolution; falls back to
 * the catalog's per-video estimate for token-priced models.
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
  const exact = pricing ? positive(computeVideoCost(pricing, 0, params)?.totalCost) : undefined;
  if (exact) return exact;

  return positive(model.approximatePricePerVideo ?? pricing?.approximatePricePerVideo);
};
