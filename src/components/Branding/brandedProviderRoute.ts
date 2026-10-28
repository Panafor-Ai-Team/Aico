import {
  BRANDING_PROVIDER,
  DEFAULT_MANAGED_PROVIDER_ID,
  MANAGED_PROVIDER_IDS,
} from '@lobechat/business-const';

import { isCustomBranding } from '@/const/version';

import { getBrandingModelSlug, isBrandedOpenRouterProvider } from './brandedModelId';

/**
 * URL spellings that all mean "the branded managed provider".
 *
 * `aico` predates this helper (the provider menu already treated it as the
 * branded slot) and stays accepted so older links keep resolving.
 */
const BRANDED_ROUTE_ALIASES = ['aico'];

/**
 * The id the branded slot is stored under. `BRANDING_PROVIDER` when it names a
 * managed gateway, else the default slot (`openrouter`). It cannot simply be
 * `BRANDING_PROVIDER`: a deployment that leaves it unset gets `official`, which no
 * provider row carries, and the slot would then keep its gateway name in the URL.
 */
const BRANDED_SLOT_ID: string = (MANAGED_PROVIDER_IDS as readonly string[]).includes(
  BRANDING_PROVIDER,
)
  ? BRANDING_PROVIDER
  : DEFAULT_MANAGED_PROVIDER_ID;

/**
 * The provider id as it should appear in a URL.
 *
 * The managed experience is stored under a gateway id — today the literal string
 * `openrouter`, because that id is written into every saved agent config
 * and catalog row and renaming it would strand them. That is a storage detail,
 * not something to show a user whose traffic may not even go to OpenRouter, so
 * the branded slot gets the product's own slug in the address bar.
 */
export const toProviderRouteSegment = (providerId: string | null | undefined): string => {
  const id = providerId ?? '';
  return isCustomBranding && (id === BRANDING_PROVIDER || isBrandedOpenRouterProvider(id))
    ? getBrandingModelSlug()
    : id;
};

/**
 * Inverse of {@link toProviderRouteSegment}: a URL segment back to the stored id.
 *
 * Deliberately permissive. `BRANDING_PROVIDER` itself still resolves, so links
 * and bookmarks minted before the pretty URL existed keep working.
 */
export const fromProviderRouteSegment = (segment: string | null | undefined): string => {
  const raw = segment ?? '';
  if (!isCustomBranding) return raw;
  const normalized = raw.trim().toLowerCase();
  return normalized === getBrandingModelSlug() || BRANDED_ROUTE_ALIASES.includes(normalized)
    ? BRANDED_SLOT_ID
    : raw;
};

/** True when this URL segment addresses the branded managed provider. */
export const isBrandedProviderRouteSegment = (segment: string | null | undefined): boolean =>
  Boolean(isCustomBranding && segment && fromProviderRouteSegment(segment) === BRANDED_SLOT_ID);
