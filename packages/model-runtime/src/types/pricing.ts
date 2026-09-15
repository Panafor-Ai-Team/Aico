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
  scope: 'personal';
}
