export interface ModelPricingContext {
  /**
   * AICO-180 platform usage multiplier in basis points (12000 = 1.20x).
   * Set server-side for managed Aico traffic so the cost reported for a
   * generation is the billed figure, never the raw upstream rate.
   */
  costMultiplierBp?: number;
  plan: string;
  scope: 'personal';
}
