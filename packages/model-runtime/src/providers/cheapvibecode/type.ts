/**
 * CheapVibeCode's `/v1/models` entry.
 *
 * The catalog is richer than the published docs suggest but carries **no USD
 * pricing**: cost is a `multiplier` applied to CVC's own token unit, and the
 * account is denominated in those tokens. Every USD figure we show is therefore
 * derived, never quoted — see `AICO_CVC_TOKENS_PER_USD`.
 */
export interface CheapVibeCodeModelCard {
  /** Coefficient before any speed tier is applied. */
  base_multiplier?: number | null;
  context_window?: number | null;
  created?: number | null;
  description?: string | null;
  display_name?: string | null;
  /** Coefficient for the low-latency route, when the model has one. */
  fast_multiplier?: number | null;
  id: string;
  input_modalities?: string[] | null;
  max_output_tokens?: number | null;
  /** CVC tokens charged per token of traffic. The figure billing uses. */
  multiplier?: number | null;
  name?: string | null;
  /** Percentage relative to `gpt-5.6-luna` = 100, where published. */
  quality?: number | null;
  supports_reasoning?: boolean | null;
  supports_tools?: boolean | null;
  supports_vision?: boolean | null;
}

export interface CheapVibeCodeModelsResponse {
  data?: CheapVibeCodeModelCard[] | null;
  models?: CheapVibeCodeModelCard[] | null;
}
