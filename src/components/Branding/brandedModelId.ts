import { BRANDING_NAME, MANAGED_PROVIDER_IDS } from '@lobechat/business-const';

import { isCustomBranding } from '@/const/version';

/** Slug used in UI model ids, e.g. `aico` from branding name `Aico`. */
export const getBrandingModelSlug = (): string => BRANDING_NAME.trim().toLowerCase();

/**
 * Every managed gateway id, matched as an id prefix.
 *
 * All of them are branded, not only the active one: which gateway is live is a
 * server-side decision (`AICO_MANAGED_PROVIDER` has no `NEXT_PUBLIC_` twin), and
 * stored ids outlive a switch. Branding on the union means a model saved before
 * a cutover still shows as ours afterwards, and a rollback does not unbrand it.
 */
const MANAGED_ID_PREFIX = new RegExp(`^(?:${MANAGED_PROVIDER_IDS.join('|')})\\b`, 'i');
const MANAGED_ID_LEADER = new RegExp(`^(?:${MANAGED_PROVIDER_IDS.join('|')})/?`, 'i');
const MANAGED_PROVIDER_EXACT = new RegExp(`^(?:${MANAGED_PROVIDER_IDS.join('|')})$`, 'i');

/**
 * True when this model id is a managed-gateway-namespace id that should show as
 * our brand (e.g. `openrouter/auto` → `aico/auto` + ProductLogo).
 * Matches ModelIcon's `^openrouter` keyword so any gateway-owned id is branded.
 */
export const isBrandedOpenRouterModelId = (modelId: string): boolean =>
  Boolean(isCustomBranding && modelId && MANAGED_ID_PREFIX.test(modelId));

/** Display-only id; runtime/API ids keep their stored gateway prefix. */
export const formatBrandedModelId = (modelId: string): string => {
  if (!isBrandedOpenRouterModelId(modelId)) return modelId;
  const rest = modelId.replace(MANAGED_ID_LEADER, '');
  return rest ? `${getBrandingModelSlug()}/${rest}` : getBrandingModelSlug();
};

/** True when this runtime provider id should show as product brand in the UI. */
export const isBrandedOpenRouterProvider = (provider?: string): boolean =>
  Boolean(isCustomBranding && provider && MANAGED_PROVIDER_EXACT.test(provider.trim()));

/** Display-only provider label; runtime/API ids keep their stored gateway id. */
export const formatBrandedProviderId = (provider: string): string => {
  if (!isBrandedOpenRouterProvider(provider)) return provider;
  return BRANDING_NAME;
};
