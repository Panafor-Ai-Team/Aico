import type { ModelRating } from 'model-bank';

import { CURATED_MODEL_RATINGS } from './modelRatings';

export interface BusinessModelRatingParams {
  model?: string;
  provider?: string;
}

/**
 * Curated AA snapshot (see modelRatings.ts); ids may arrive vendor-prefixed.
 * `provider` is ignored — same model id, same benchmarks.
 */
export const applyBusinessModelRating = ({
  model,
}: BusinessModelRatingParams): ModelRating | undefined => {
  const id = model?.includes('/') ? model.slice(model.lastIndexOf('/') + 1) : model;

  return id ? CURATED_MODEL_RATINGS[id] : undefined;
};

export const useBusinessModelRating = () => applyBusinessModelRating;
