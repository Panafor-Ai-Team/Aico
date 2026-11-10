import type { Pricing } from 'model-bank';

export interface ModelPricingContext {
  /**
   * AICO-180 platform usage multiplier in basis points (12000 = 1.20x).
   * Set server-side for managed Aico traffic so the cost reported for a
   * generation is the billed figure, never the raw upstream rate.
   */
  costMultiplierBp?: number;
  /**
   * AICO-187 per-model coefficient corrections, `modelId` -> basis points
   * (10000 = 1.00x, i.e. no correction). Composed with `costMultiplierBp` so a
   * reported cost matches the price shown for that model in the picker, which
   * applies the same pair.
   */
  modelCostMultiplierBp?: Record<string, number>;
  plan: string;
  /**
   * Pricing resolved server-side from the managed model catalog for the
   * requested model. Wins over the static bank so dynamic catalog ids (which
   * the bank never lists) still get a stream-time cost. Ignored unless the
   * model id matches exactly.
   */
  resolvedPricing?: { modelId: string; pricing: Pricing };
  scope: 'personal';
}
