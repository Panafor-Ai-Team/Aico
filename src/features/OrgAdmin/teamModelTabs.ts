import type { Pricing, PricingUnit, PricingUnitName } from 'model-bank';

import {
  formatPiAmount,
  formatTokenCoefficient,
  rawUsdToPiTokens,
} from '@/features/AicoBilling/piToken';

export type TeamCatalogModel = {
  approximatePricePerImage?: number | null;
  approximatePricePerVideo?: number | null;
  displayName?: string | null;
  id: string;
  pricing?: Pricing | null;
  type?: string | null;
};

const TYPE_ORDER = ['chat', 'image', 'video'];

const rank = (type: string) => TYPE_ORDER.indexOf(type) + 1 || TYPE_ORDER.length + 1;

const teamModelType = (model: TeamCatalogModel) => model.type || 'chat';

/**
 * One tab per model type in the catalog, chat → image → video first, then any
 * other type. An `all` tab leads when the catalog spans several types so the
 * admin can search across everything. Built from the whole catalog (not the
 * search result) so tabs don't vanish while the admin is typing.
 *
 * When `isEnabled` is given, each tab lists enabled models first (stable —
 * catalog order is kept within each group).
 */
export const buildTeamModelTabs = (
  models: TeamCatalogModel[],
  isEnabled?: (modelId: string) => boolean,
) => {
  const byType = new Map<string, TeamCatalogModel[]>();
  for (const model of models) {
    const type = teamModelType(model);
    byType.set(type, [...(byType.get(type) ?? []), model]);
  }
  const ordered: Array<{ items: TeamCatalogModel[]; type: string }> = [];
  if (byType.size > 1) ordered.push({ items: [...models], type: 'all' });
  for (const [type, items] of [...byType.entries()].sort(([a], [b]) => rank(a) - rank(b))) {
    ordered.push({ items, type });
  }
  if (!isEnabled) return ordered;
  for (const tab of ordered) {
    tab.items.sort((a, b) => Number(isEnabled(b.id)) - Number(isEnabled(a.id)));
  }
  return ordered;
};

const positiveRate = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;

/** First rate of a pricing unit (fixed → rate, tiered → first tier, lookup → first price). */
const unitRate = (
  pricing: Pricing | null | undefined,
  name: PricingUnitName,
): number | undefined => {
  const unit: PricingUnit | undefined = pricing?.units?.find((item) => item.name === name);
  if (!unit) return undefined;
  if (unit.strategy === 'fixed') return positiveRate(unit.rate);
  if (unit.strategy === 'tiered') return positiveRate(unit.tiers?.[0]?.rate);
  if (unit.strategy === 'lookup') {
    const first = Object.values(unit.lookup?.prices ?? {})[0];
    return positiveRate(first);
  }
  return undefined;
};

export type TeamModelCost =
  | { input: string; kind: 'chat-split'; output: string }
  | { coefficient: string; kind: 'chat-single' }
  | { kind: 'per-image'; piAmount: string }
  | { kind: 'per-video'; piAmount: string };

/**
 * What the org admin pays when a team uses this model, in the same convention
 * as the site's model picker: chat shows the CVC usage coefficient (×),
 * image/video shows the π amount per item. Null when the catalog has no usable
 * price for the model.
 */
export const getTeamModelCost = (model: TeamCatalogModel): TeamModelCost | null => {
  const type = teamModelType(model);
  if (type === 'image') {
    const rate =
      positiveRate(model.approximatePricePerImage) ??
      positiveRate(model.pricing?.approximatePricePerImage) ??
      unitRate(model.pricing, 'imageGeneration');
    return rate ? { kind: 'per-image', piAmount: formatPiAmount(rawUsdToPiTokens(rate)) } : null;
  }
  if (type === 'video') {
    const rate =
      positiveRate(model.approximatePricePerVideo) ??
      positiveRate(model.pricing?.approximatePricePerVideo) ??
      unitRate(model.pricing, 'videoGeneration');
    return rate ? { kind: 'per-video', piAmount: formatPiAmount(rawUsdToPiTokens(rate)) } : null;
  }
  const input = unitRate(model.pricing, 'textInput');
  if (!input) return null;
  const output = unitRate(model.pricing, 'textOutput');
  if (!output || output === input) {
    return { coefficient: formatTokenCoefficient(input), kind: 'chat-single' };
  }
  return {
    input: formatTokenCoefficient(input),
    kind: 'chat-split',
    output: formatTokenCoefficient(output),
  };
};
