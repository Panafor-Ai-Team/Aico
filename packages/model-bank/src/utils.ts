import type {
  AiModelSettings,
  AiModelType,
  LobeDefaultAiModelListItem,
  ModelSearchImplementType,
  Pricing,
  PricingUnit,
} from './types';

export interface ResolveSearchDecisionInput {
  modelSearchImpl?: ModelSearchImplementType | null;
  providerSearchMode?: ModelSearchImplementType | null;
  searchMode?: 'auto' | 'off' | 'on';
  useModelBuiltinSearch?: boolean;
}

export interface SearchDecision {
  enabledSearch: boolean;
  isModelHasBuiltinSearch: boolean;
  isProviderHasBuiltinSearch: boolean;
  useApplicationBuiltinSearchTool: boolean;
  useModelSearch: boolean;
}

/**
 * Resolves the mutually exclusive search route shared by client and server runtimes.
 *
 * `internal` and `tool` always prefer the model's native search while search is on
 * (no second "use model builtin search" toggle). `params` still requires that toggle.
 */
export const resolveSearchDecision = ({
  modelSearchImpl,
  providerSearchMode,
  searchMode,
  useModelBuiltinSearch,
}: ResolveSearchDecisionInput): SearchDecision => {
  const enabledSearch = searchMode !== 'off';
  const isModelHasBuiltinSearch = !!modelSearchImpl;
  const isProviderHasBuiltinSearch = !!providerSearchMode;
  // `internal` = always-on native search (Perplexity, Jina, …).
  // `tool` = provider server tools (e.g. xAI web_search / x_search) — prefer native
  // whenever search is enabled so Live Search is not skipped for the app helper.
  const prefersNativeBuiltinSearch =
    modelSearchImpl === 'internal' ||
    modelSearchImpl === 'tool' ||
    providerSearchMode === 'internal' ||
    providerSearchMode === 'tool';
  const useModelSearch =
    enabledSearch &&
    (prefersNativeBuiltinSearch ||
      ((isModelHasBuiltinSearch || isProviderHasBuiltinSearch) && !!useModelBuiltinSearch));

  return {
    enabledSearch,
    isModelHasBuiltinSearch,
    isProviderHasBuiltinSearch,
    useApplicationBuiltinSearchTool: enabledSearch && !useModelSearch,
    useModelSearch,
  };
};

type ModelSearchSettings = Pick<AiModelSettings, 'searchImpl' | 'searchProvider'>;

const PROVIDER_SEARCH_DEFAULTS: Record<string, ModelSearchSettings> = {
  ai360: { searchImpl: 'params' },
  aihubmix: { searchImpl: 'params' },
  anthropic: { searchImpl: 'params' },
  baichuan: { searchImpl: 'params' },
  default: { searchImpl: 'params' },
  google: { searchImpl: 'params', searchProvider: 'google' },
  hunyuan: { searchImpl: 'params' },
  jina: { searchImpl: 'internal' },
  minimax: { searchImpl: 'params' },
  openai: { searchImpl: 'params' },
  perplexity: { searchImpl: 'internal' },
  qwen: { searchImpl: 'params' },
  spark: { searchImpl: 'params' },
  stepfun: { searchImpl: 'params' },
  vertexai: { searchImpl: 'params', searchProvider: 'google' },
  wenxin: { searchImpl: 'params' },
  xai: { searchImpl: 'tool' },
  zhipu: { searchImpl: 'params' },
};

const MODEL_SEARCH_DEFAULTS: Record<string, Record<string, ModelSearchSettings>> = {
  openai: {
    'gpt-4o-mini-search-preview': { searchImpl: 'internal' },
    'gpt-4o-search-preview': { searchImpl: 'internal' },
  },
  spark: {
    'max-32k': { searchImpl: 'internal' },
  },
};

/**
 * Infers search settings for remotely discovered models that only expose abilities.search.
 */
export const resolveModelSearchDefaultSettings = (
  providerId: string | undefined,
  modelId: string,
): ModelSearchSettings =>
  (providerId && MODEL_SEARCH_DEFAULTS[providerId]?.[modelId]) ||
  (providerId && PROVIDER_SEARCH_DEFAULTS[providerId]) ||
  PROVIDER_SEARCH_DEFAULTS.default;

export const isProviderModelAvailable = (
  models: LobeDefaultAiModelListItem[],
  providerId: string,
  id: string,
  expectedType: AiModelType,
): boolean =>
  models.some(
    (model) =>
      model.providerId === providerId &&
      model.id === id &&
      model.enabled !== false &&
      model.type === expectedType,
  );

// ─── Usage multiplier (AICO-180) ───────────────────────────────────────

const MULTIPLIER_BP_SCALE = 10_000;

const scaleRate = (rate: number, bp: number): number => (rate * bp) / MULTIPLIER_BP_SCALE;

const scaleOptionalRate = (rate: number | undefined, bp: number): number | undefined =>
  typeof rate === 'number' ? scaleRate(rate, bp) : undefined;

const scalePriceMap = (
  prices: Record<string, number> | undefined,
  bp: number,
): Record<string, number> | undefined => {
  if (!prices) return undefined;
  return Object.fromEntries(
    Object.entries(prices).map(([key, value]) => [key, scaleRate(value, bp)]),
  );
};

const scaleUnit = (unit: PricingUnit, bp: number): PricingUnit => {
  switch (unit.strategy) {
    case 'fixed': {
      return {
        ...unit,
        originalRate: scaleOptionalRate(unit.originalRate, bp),
        rate: scaleRate(unit.rate, bp),
      };
    }
    case 'tiered': {
      return {
        ...unit,
        tiers: unit.tiers.map((tier) => ({
          ...tier,
          originalRate: scaleOptionalRate(tier.originalRate, bp),
          rate: scaleRate(tier.rate, bp),
        })),
      };
    }
    case 'lookup': {
      return {
        ...unit,
        lookup: {
          ...unit.lookup,
          originalPrices: scalePriceMap(unit.lookup.originalPrices, bp),
          prices: scalePriceMap(unit.lookup.prices, bp) ?? {},
        },
      };
    }
    default: {
      return unit;
    }
  }
};

/**
 * Scale every price-bearing field of a `Pricing` by a basis-point multiplier.
 *
 * The unit type (millionTokens / image / video / second / megapixel) is
 * irrelevant: every unit is `rate x quantity`, so scaling the rate scales the
 * cost identically for token, per-image and per-second models alike.
 *
 * `originalRate` / `originalPrices` are display-only "before discount" mirrors
 * and are scaled too — leaving them raw would render a struck-through real
 * price next to a marked-up one and leak the underlying rate.
 *
 * Rates stay floating point (prices are small decimals, 0.01 -> 0.012);
 * rounding happens only when a computed cost is converted to integer micro-USD.
 */
export const applyPricingMultiplier = <T extends Pricing | undefined>(
  pricing: T,
  bp: number | null | undefined,
): T => {
  if (!pricing) return pricing;
  const multiplier = Math.trunc(Number(bp ?? MULTIPLIER_BP_SCALE));
  if (!Number.isFinite(multiplier) || multiplier <= 0 || multiplier === MULTIPLIER_BP_SCALE) {
    return pricing;
  }

  return {
    ...pricing,
    approximatePricePerImage: scaleOptionalRate(pricing.approximatePricePerImage, multiplier),
    approximatePricePerVideo: scaleOptionalRate(pricing.approximatePricePerVideo, multiplier),
    units: (pricing.units ?? []).map((unit) => scaleUnit(unit, multiplier)),
  } as T;
};
