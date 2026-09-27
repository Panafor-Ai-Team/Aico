import {
  BRANDING_PROVIDER,
  DEFAULT_MANAGED_PROVIDER_ID,
  MANAGED_PROVIDER_IDS,
  type ManagedProviderId,
} from '@lobechat/business-const';
import { getCachedTextInputUnitRate } from '@lobechat/utils';
import type { TFunction } from 'i18next';
import type { LucideIcon } from 'lucide-react';
import {
  ArrowDownToDot,
  ArrowUpFromDot,
  AtomIcon,
  AudioLinesIcon,
  CircleFadingArrowUp,
  EyeIcon,
  GlobeIcon,
  ImageIcon,
  PaperclipIcon,
  VideoIcon,
  WrenchIcon,
} from 'lucide-react';
import type {
  FixedPricingUnit,
  ModelPriceCurrency,
  Pricing,
  PricingUnit,
  PricingUnitName,
  TieredPricingUnit,
} from 'model-bank';
import { useCallback, useMemo } from 'react';

import { useBusinessModelPricing } from '@/business/client/hooks/useBusinessModelPricing';
import { useBusinessModelRating } from '@/business/client/hooks/useBusinessModelRating';
import {
  formatPiAmount,
  formatTokenCoefficient,
  rawUsdToPiTokens,
} from '@/features/AicoBilling/piToken';
import { useEnabledChatModels } from '@/hooks/useEnabledChatModels';
import { useGlobalStore } from '@/store/global';
import type { ModelDetailPanelExpandedKey } from '@/store/global/initialState';
import { systemStatusSelectors } from '@/store/global/selectors';
import type { EnabledProviderWithModels } from '@/types/aiProvider';
import { formatTokenNumber } from '@/utils/format';
import { formatPriceByCurrency, getOriginalUnitRateByName, getUnitRateByName } from '@/utils/index';

import type { PricingMode } from '../types';

export interface FormattedUnitPrice {
  current: string;
  original?: string;
}

interface TextPriceSummary {
  cachedInput: FormattedUnitPrice;
  input: FormattedUnitPrice;
  output: FormattedUnitPrice;
}

interface FormatPricingRateOptions {
  isCreditPricing?: boolean;
  unit?: PricingUnit['unit'];
}

/**
 * Managed / branding catalog prices are shown in π (raw USD × CVC bridge).
 * Direct third-party providers (openai, anthropic, …) keep `$`.
 */
export const isPiPricingProvider = (provider?: string): boolean => {
  if (!provider) return false;
  if (provider === BRANDING_PROVIDER) return true;
  if (provider === DEFAULT_MANAGED_PROVIDER_ID) return true;
  return MANAGED_PROVIDER_IDS.includes(provider as ManagedProviderId);
};

/** Format a raw USD catalog rate as π amount (no unit). */
export const formatPiRate = (rate: number) => formatPiAmount(rawUsdToPiTokens(rate));

const isTokenUnit = (unit?: PricingUnit['unit']) => unit === 'millionTokens' || unit === undefined;

/**
 * Token rates: coefficient only (`4×`).
 * Non-token units (image/video/…): π amount, rendered next to the π coin.
 */
export const formatManagedPricingRate = (rate: number, unit?: PricingUnit['unit']): string =>
  isTokenUnit(unit) ? formatTokenCoefficient(rate) : formatPiRate(rate);

const formatPricingRate = (
  rate: number | undefined,
  currency?: ModelPriceCurrency,
  options: FormatPricingRateOptions = {},
) => {
  if (typeof rate !== 'number') return '0';

  if (options.isCreditPricing) {
    return formatManagedPricingRate(rate, options.unit);
  }

  return formatPriceByCurrency(rate, currency);
};

const getFormattedUnitPrice = (
  pricing: Pricing,
  unitName: PricingUnitName,
  isCreditPricing: boolean,
): FormattedUnitPrice => {
  const currency = pricing.currency as ModelPriceCurrency | undefined;
  const currentRate = getUnitRateByName(pricing, unitName);
  const originalRate = getOriginalUnitRateByName(pricing, unitName);

  return {
    current: formatPricingRate(currentRate, currency, {
      isCreditPricing,
      unit: 'millionTokens',
    }),
    original:
      typeof originalRate === 'number'
        ? formatPricingRate(originalRate, currency, {
            isCreditPricing,
            unit: 'millionTokens',
          })
        : undefined,
  };
};

const getPrice = (pricing: Pricing, isCreditPricing: boolean): TextPriceSummary => {
  return {
    cachedInput: getFormattedUnitPrice(pricing, 'textInput_cacheRead', isCreditPricing),
    input: getFormattedUnitPrice(pricing, 'textInput', isCreditPricing),
    output: getFormattedUnitPrice(pricing, 'textOutput', isCreditPricing),
  };
};

type PricingGroup = 'audio' | 'image' | 'text' | 'video';

const UNIT_GROUP_MAP: Record<PricingUnitName, PricingGroup> = {
  audioInput: 'audio',
  audioInput_cacheRead: 'audio',
  audioOutput: 'audio',
  imageGeneration: 'image',
  imageInput: 'image',
  imageInput_cacheRead: 'image',
  imageOutput: 'image',
  textInput: 'text',
  textInput_cacheRead: 'text',
  textInput_cacheWrite: 'text',
  textOutput: 'text',
  videoInput: 'video',
  videoGeneration: 'video',
};

const GROUP_ORDER: PricingGroup[] = ['text', 'image', 'audio', 'video'];

/**
 * CVC bills input and output at one coefficient; when a managed catalog says
 * the same, the picker shows one rate instead of two identical ones.
 */
export const hasSingleTextRate = (pricing: Pricing): boolean => {
  const textUnits = pricing.units.filter((unit) => UNIT_GROUP_MAP[unit.name] === 'text');
  if (textUnits.some((unit) => unit.name !== 'textInput' && unit.name !== 'textOutput')) {
    return false;
  }
  const input = getUnitRateByName(pricing, 'textInput');
  const output = getUnitRateByName(pricing, 'textOutput');
  return typeof input === 'number' && input === output;
};

export const UNIT_ICON_MAP: Partial<Record<PricingUnitName, LucideIcon>> = {
  audioInput: ArrowUpFromDot,
  audioInput_cacheRead: CircleFadingArrowUp,
  audioOutput: ArrowDownToDot,
  imageGeneration: ImageIcon,
  imageInput: ArrowUpFromDot,
  imageInput_cacheRead: CircleFadingArrowUp,
  imageOutput: ArrowDownToDot,
  textInput: ArrowUpFromDot,
  textInput_cacheRead: CircleFadingArrowUp,
  textInput_cacheWrite: CircleFadingArrowUp,
  textOutput: ArrowDownToDot,
  videoGeneration: VideoIcon,
};

const UNIT_SORT_ORDER: Record<PricingUnitName, number> = {
  textInput: 0,
  textOutput: 1,
  textInput_cacheRead: 2,
  textInput_cacheWrite: 3,
  imageInput: 0,
  imageOutput: 1,
  imageInput_cacheRead: 2,
  imageGeneration: 3,
  audioInput: 0,
  audioOutput: 1,
  audioInput_cacheRead: 2,
  videoInput: 0,
  videoGeneration: 1,
};

const UNIT_LABEL_MAP: Record<string, string> = {
  image: '/img',
  megapixel: '/MP',
  millionCharacters: '/M chars',
  millionTokens: '/M tokens',
  second: '/s',
  video: '/video',
};

const formatUnitRate = (
  unit: PricingUnit,
  currency?: ModelPriceCurrency,
  isCreditPricing?: boolean,
): FormattedUnitPrice => {
  const formatRate = (rate: number) =>
    formatPricingRate(rate, currency, { isCreditPricing, unit: unit.unit });
  const formatRange = (low: string, high: string) =>
    isCreditPricing ? `${low} ~ ${high}` : `${low} ~ $${high}`;

  if (unit.strategy === 'fixed') {
    const fixedUnit = unit as FixedPricingUnit;
    return {
      current: formatRate(fixedUnit.rate),
      original:
        typeof fixedUnit.originalRate === 'number' && fixedUnit.originalRate > fixedUnit.rate
          ? formatRate(fixedUnit.originalRate)
          : undefined,
    };
  }

  if (unit.strategy === 'tiered') {
    const tiers = (unit as TieredPricingUnit).tiers;
    if (tiers.length === 1) {
      const price = formatRate(tiers[0].rate);
      return {
        current: price,
        original:
          typeof tiers[0].originalRate === 'number' && tiers[0].originalRate > tiers[0].rate
            ? formatRate(tiers[0].originalRate)
            : undefined,
      };
    }
    const low = formatRate(tiers[0].rate);
    const high = formatRate(tiers.at(-1)!.rate);
    const originalLow = tiers[0].originalRate;
    const originalHigh = tiers.at(-1)!.originalRate;
    const original =
      typeof originalLow === 'number' &&
      typeof originalHigh === 'number' &&
      (originalLow > tiers[0].rate || originalHigh > tiers.at(-1)!.rate)
        ? formatRange(formatRate(originalLow), formatRate(originalHigh))
        : undefined;
    return { current: formatRange(low, high), original };
  }

  if (unit.strategy === 'lookup') {
    const entries = Object.entries(unit.lookup.prices);
    if (entries.length === 0) return { current: '-' };

    if (entries.length === 1) {
      const [key, price] = entries[0];
      const originalPrice = unit.lookup.originalPrices?.[key];
      return {
        current: formatRate(price),
        original:
          typeof originalPrice === 'number' && originalPrice > price
            ? formatRate(originalPrice)
            : undefined,
      };
    }
    const sorted = [...entries].sort((a, b) => a[1] - b[1]);
    const [lowKey, lowPrice] = sorted[0];
    const [highKey, highPrice] = sorted.at(-1)!;
    const originalLow = unit.lookup.originalPrices?.[lowKey];
    const originalHigh = unit.lookup.originalPrices?.[highKey];
    const original =
      typeof originalLow === 'number' &&
      typeof originalHigh === 'number' &&
      (originalLow > lowPrice || originalHigh > highPrice)
        ? formatRange(formatRate(originalLow), formatRate(originalHigh))
        : undefined;
    return { current: formatRange(formatRate(lowPrice), formatRate(highPrice)), original };
  }

  return { current: '-' };
};

interface PricingGroupData {
  group: PricingGroup;
  units: PricingUnit[];
}

const groupPricingUnits = (units: PricingUnit[]): PricingGroupData[] => {
  const map = new Map<PricingGroup, PricingUnit[]>();
  for (const unit of units) {
    const group = UNIT_GROUP_MAP[unit.name] || 'text';
    const arr = map.get(group) || [];
    arr.push(unit);
    map.set(group, arr);
  }
  for (const [, arr] of map) {
    arr.sort((a, b) => (UNIT_SORT_ORDER[a.name] ?? 99) - (UNIT_SORT_ORDER[b.name] ?? 99));
  }
  return GROUP_ORDER.filter((g) => map.has(g)).map((g) => ({ group: g, units: map.get(g)! }));
};

interface AbilityItem {
  color: string;
  icon: LucideIcon;
  key: string;
}

const ABILITY_CONFIG: AbilityItem[] = [
  { color: 'success', icon: EyeIcon, key: 'vision' },
  { color: 'success', icon: PaperclipIcon, key: 'files' },
  { color: 'success', icon: ImageIcon, key: 'imageOutput' },
  { color: 'magenta', icon: VideoIcon, key: 'video' },
  { color: 'gold', icon: AudioLinesIcon, key: 'audio' },
  { color: 'info', icon: WrenchIcon, key: 'functionCall' },
  { color: 'purple', icon: AtomIcon, key: 'reasoning' },
  { color: 'cyan', icon: GlobeIcon, key: 'search' },
];

interface UseModelDetailPanelParams {
  enabledList?: EnabledProviderWithModels[];
  modelId?: string;
  pricingMode?: PricingMode;
  provider?: string;
  t: TFunction<'components'>;
}

export const useModelDetailPanel = ({
  enabledList: enabledListProp,
  modelId,
  pricingMode,
  provider,
  t,
}: UseModelDetailPanelParams) => {
  const enabledListFromHook = useEnabledChatModels();
  const enabledList = enabledListProp ?? enabledListFromHook;
  const model = useMemo(() => {
    if (!modelId || !provider) return undefined;
    const providerData = enabledList.find((p) => p.id === provider);
    return providerData?.children.find((m) => m.id === modelId);
  }, [enabledList, modelId, provider]);

  const expandedKeys = useGlobalStore(systemStatusSelectors.modelDetailPanelExpandedKeys);
  const updateExpandedKeys = useGlobalStore((s) => s.updateModelDetailPanelExpandedKeys);
  const applyBusinessModelPricing = useBusinessModelPricing();
  const applyBusinessModelRating = useBusinessModelRating();

  const rating = useMemo(
    () => applyBusinessModelRating({ model: modelId, provider }),
    [applyBusinessModelRating, modelId, provider],
  );

  const pricing = model?.pricing;
  const displayPricing = useMemo(
    () => applyBusinessModelPricing({ model: modelId, pricing, provider }),
    [applyBusinessModelPricing, modelId, pricing, provider],
  );
  const isCreditPricing = isPiPricingProvider(provider);
  const hasPricing = !!displayPricing;
  const formatPrice = displayPricing ? getPrice(displayPricing, isCreditPricing) : null;
  const hasCachedInputPricing = displayPricing
    ? !!getCachedTextInputUnitRate(displayPricing)
    : false;
  const isSingleTextRate = isCreditPricing && !!displayPricing && hasSingleTextRate(displayPricing);
  const pricingGroups = useMemo(() => {
    if (!displayPricing) return [];
    const units = isSingleTextRate
      ? displayPricing.units.filter((unit) => unit.name !== 'textOutput')
      : displayPricing.units;
    return groupPricingUnits(units);
  }, [displayPricing, isSingleTextRate]);

  /** Managed image/video estimate as a bare π amount; the panel renders the coin. */
  const approximatePiPrice = useMemo(() => {
    if (!isCreditPricing || !displayPricing || !pricingMode) return null;
    const rate =
      pricingMode === 'image'
        ? (model?.approximatePricePerImage ?? displayPricing.approximatePricePerImage)
        : pricingMode === 'video'
          ? (model?.approximatePricePerVideo ?? displayPricing.approximatePricePerVideo)
          : undefined;
    if (typeof rate !== 'number') return null;
    return {
      amount: formatPiRate(rate),
      unit: pricingMode === 'image' ? 'image' : 'video',
    } as const;
  }, [displayPricing, isCreditPricing, model, pricingMode]);

  const approximatePriceLabel = useMemo(() => {
    if (isCreditPricing || !displayPricing || !pricingMode) return null;
    const currency = displayPricing.currency as ModelPriceCurrency | undefined;
    // Prefer the per-model approximatePricePerImage/Video field: it is computed
    // by resolveImageSinglePrice/resolveVideoSinglePrice from the pricing units
    // (including token-priced generators, which have no dedicated pricing-unit
    // field of their own), whereas displayPricing.approximatePricePerImage only
    // ever holds a value when a model-bank entry sets it explicitly.
    const approximatePricePerImage =
      model?.approximatePricePerImage ?? displayPricing.approximatePricePerImage;
    const approximatePricePerVideo =
      model?.approximatePricePerVideo ?? displayPricing.approximatePricePerVideo;
    if (pricingMode === 'image' && typeof approximatePricePerImage === 'number') {
      return t('ModelSwitchPanel.detail.pricing.perImage', {
        amount: formatPriceByCurrency(approximatePricePerImage, currency),
        defaultValue: '~ ${{amount}} / image',
      });
    }
    if (pricingMode === 'video' && typeof approximatePricePerVideo === 'number') {
      return t('ModelSwitchPanel.detail.pricing.perVideo', {
        amount: formatPriceByCurrency(approximatePricePerVideo, currency),
        defaultValue: '~ ${{amount}} / video',
      });
    }
    return null;
  }, [displayPricing, isCreditPricing, model, pricingMode, t]);

  const getCreditsUnitLabel = useCallback(
    (unit: PricingUnit['unit']) =>
      t(`ModelSwitchPanel.detail.pricing.credits.${unit}` as any, {
        defaultValue: UNIT_LABEL_MAP[unit] || '',
      }),
    [t],
  );

  const getPricingTooltip = useCallback(
    (key: 'cachedInput' | 'coefficient' | 'input' | 'output', amount: string): string => {
      if (isCreditPricing) {
        return t(`ModelSwitchPanel.detail.pricing.credits.${key}` as any, { amount });
      }

      const fallbackKey =
        key === 'cachedInput'
          ? 'ModelSwitchPanel.detail.pricing.cachedInput'
          : `ModelSwitchPanel.detail.pricing.${key}`;

      return t(fallbackKey as any, { amount });
    },
    [isCreditPricing, t],
  );

  const formatUnitPrice = useCallback(
    (unit: PricingUnit) =>
      formatUnitRate(unit, displayPricing?.currency as ModelPriceCurrency, isCreditPricing),
    [displayPricing?.currency, isCreditPricing],
  );

  const getUnitPriceSuffix = useCallback(
    (unit: PricingUnit['unit']) => {
      if (!isCreditPricing) return UNIT_LABEL_MAP[unit] || '';
      return isTokenUnit(unit) ? '' : getCreditsUnitLabel(unit);
    },
    [getCreditsUnitLabel, isCreditPricing],
  );

  /** Managed non-token units show a π amount, so the panel renders the coin before the suffix. */
  const isPiAmountUnit = useCallback(
    (unit: PricingUnit['unit']) => isCreditPricing && !isTokenUnit(unit),
    [isCreditPricing],
  );

  const handleExpandedChange = useCallback(
    (keys: unknown[]) => updateExpandedKeys(keys as ModelDetailPanelExpandedKey[]),
    [updateExpandedKeys],
  );

  const contextWindowLabel = useMemo(() => {
    if (typeof model?.contextWindowTokens !== 'number') return null;

    return model.contextWindowTokens === 0
      ? '∞'
      : `${formatTokenNumber(model.contextWindowTokens)} tokens`;
  }, [model?.contextWindowTokens]);

  const enabledAbilities = useMemo(
    () =>
      model
        ? ABILITY_CONFIG.filter((a) => model.abilities[a.key as keyof typeof model.abilities])
        : [],
    [model],
  );

  return {
    approximatePiPrice,
    approximatePriceLabel,
    contextWindowLabel,
    enabledAbilities,
    expandedKeys,
    formatPrice,
    formatUnitPrice,
    getCreditsUnitLabel,
    getPricingTooltip,
    getUnitPriceSuffix,
    handleExpandedChange,
    hasAbilities: enabledAbilities.length > 0,
    hasCachedInputPricing,
    hasPricing,
    isAbilitiesExpanded: expandedKeys.includes('abilities'),
    isCreditPricing,
    isPiAmountUnit,
    isPricingExpanded: expandedKeys.includes('pricing'),
    isSingleTextRate,
    model,
    pricingGroups,
    rating,
  };
};
