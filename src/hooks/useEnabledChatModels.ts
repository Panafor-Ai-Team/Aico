import {
  BRANDING_NAME,
  DEFAULT_PROVIDER,
  OPENROUTER_AUTO_MODEL_ID,
} from '@lobechat/business-const';
import isEqual from 'fast-deep-equal';
import { type AiModelForSelect, type AiProviderModelListItem } from 'model-bank';
import { useMemo } from 'react';

import {
  formatBrandedProviderId,
  isBrandedOpenRouterProvider,
} from '@/components/Branding/brandedModelId';
import {
  filterAicoManagedProviders,
  isAicoManagedRuntimeProvider,
} from '@/features/AicoBilling/isManagedRuntimeProvider';
import { useAicoBillingStore } from '@/features/AicoBilling/store';
import { useClientDataSWR } from '@/libs/swr';
import { lambdaClient } from '@/libs/trpc/client';
import { aiModelService } from '@/services/aiModel';
import { useAiInfraStore } from '@/store/aiInfra';
import { type EnabledProviderWithModels } from '@/types/aiProvider';

const catalogModelToSelect = (model: AiProviderModelListItem): AiModelForSelect => ({
  abilities: (model.abilities || {}) as AiModelForSelect['abilities'],
  contextWindowTokens: model.contextWindowTokens,
  description: model.description,
  displayName: model.displayName,
  family: model.family,
  generation: model.generation,
  id: model.id,
  knowledgeCutoff: model.knowledgeCutoff,
  parameters: model.parameters,
  pricing: model.pricing,
  releasedAt: model.releasedAt,
});

const withBrandedProviderName = <T extends { id: string; name: string }>(provider: T): T =>
  isBrandedOpenRouterProvider(provider.id)
    ? { ...provider, name: formatBrandedProviderId(provider.id) }
    : provider;

/**
 * Find a model in the switcher-visible list (same universe the model trigger
 * renders and writes), with the managed-provider alias leniency the runtime
 * applies at request time. Returns the list entry so callers read the same
 * abilities the switcher badges show — never a staler copy.
 */
export const findChatModelInList = (
  list: EnabledProviderWithModels[],
  model: string,
  provider: string,
): AiModelForSelect | undefined => {
  const exact = list
    .find((item) => item.id === provider)
    ?.children.find((item) => item.id === model);
  if (exact) return exact;

  if (!isAicoManagedRuntimeProvider(provider)) return undefined;
  return list
    .find((item) => isAicoManagedRuntimeProvider(item.id))
    ?.children.find((item) => item.id === model);
};

interface EnabledChatModelsState {
  /**
   * Whether absence from the list is evidence of revocation (org allow-list
   * and catalog actually loaded) rather than missing data. The auto-switch
   * judges "model revoked" only on a confirmed list.
   */
  isDataConfirmed: boolean;
  /**
   * True while the list is still a fail-closed placeholder: billing context not
   * resolved yet, managed status in flight, or the org allow-list/catalog still
   * loading. Consumers that judge "model missing" must wait on this.
   */
  isPending: boolean;
  list: EnabledProviderWithModels[];
}

/**
 * How often an open org-wallet session re-checks team access and the managed
 * catalog. An admin revocation/deletion otherwise only reaches the client on
 * window focus (throttled) — the revoked model would sit in the selector and
 * the session would stay parked on it. Same cadence as the inbox unread poll.
 */
export const ORG_MODEL_ACCESS_REFRESH_INTERVAL = 60_000;

/**
 * Enabled chat models for the model switcher.
 *
 * - Personal wallet: user's enabled managed models (preferences).
 * - Org wallet: team allow-list only — built from the managed catalog,
 *   ignoring personal enable toggles.
 */
export const useEnabledChatModelsState = (): EnabledChatModelsState => {
  const enabledChatModelList = useAiInfraStore((s) => s.enabledChatModelList, isEqual);
  const billingContext = useAicoBillingStore((s) => s.context);

  const { data: managedStatus, isLoading: isManagedStatusLoading } = useClientDataSWR(
    'aico-provider-status',
    () => lambdaClient.aicoBilling.getManagedProviderStatus.query(),
  );
  // Fail-closed: hide BYOK providers until the API says unmanaged.
  const aicoManaged = managedStatus?.managed ?? true;

  const orgId =
    billingContext?.source === 'organization' ? billingContext.organizationId : undefined;

  const { data: allowed, isLoading: isAllowedLoading } = useClientDataSWR(
    orgId ? ['aico-my-allowed-models', orgId] : null,
    () => lambdaClient.organization.getMyAllowedModels.query({ organizationId: orgId! }),
    // Poll while mounted: team access is revoked server-side at any moment and
    // the selector + auto-switch must pick that up without a focus change.
    { refreshInterval: ORG_MODEL_ACCESS_REFRESH_INTERVAL },
  );

  // The catalog is org-independent (it enumerates everything the gateway can
  // offer), so fetch it on mount instead of serializing it behind the billing
  // round-trip that produces orgId. Refresh cycles are an org concern only.
  const { data: catalog, isLoading: isCatalogLoading } = useClientDataSWR(
    ['aico-managed-model-catalog'],
    () => aiModelService.getAiProviderModelList(DEFAULT_PROVIDER),
    // Same poll: an admin catalog disable must also drop the model promptly.
    { refreshInterval: orgId ? ORG_MODEL_ACCESS_REFRESH_INTERVAL : undefined },
  );

  const isPending =
    !billingContext ||
    !!isManagedStatusLoading ||
    (!!orgId && (!!isAllowedLoading || !!isCatalogLoading));

  /**
   * Whether absence from the list is evidence (not just missing data). The
   * auto-switch must only treat "model not in list" as revoked when the org
   * allow-list and catalog actually loaded: a first load that errors leaves a
   * degraded fail-closed list, which must never read as "revoked" and clobber
   * the user's model. Legitimately empty responses are defined values, not this.
   */
  const isDataConfirmed = !orgId || (allowed !== undefined && catalog !== undefined);

  const list = useMemo(() => {
    const list = enabledChatModelList || [];
    const scoped = (aicoManaged ? filterAicoManagedProviders(list) : list).map(
      withBrandedProviderName,
    );

    if (!orgId) return scoped;

    // Fail closed while allow-list or catalog loads: hide managed models until known.
    if (!allowed || !catalog) {
      return scoped.filter((provider) => !isAicoManagedRuntimeProvider(provider.id));
    }

    // Auto is the product's meta-router, not an admin-grantable team model —
    // always present in org wallet mode regardless of the team's allow-list.
    // A model the platform admin disabled (`enabled: false`) is hidden even
    // when team-granted — a deleted/disabled model must leave the selector so
    // the session can fall back instead of parking on it.
    const allowSet = new Set(allowed.modelIds);
    const children = catalog
      .filter(
        (model) =>
          (model.type || 'chat') === 'chat' &&
          (model.id === OPENROUTER_AUTO_MODEL_ID ||
            (allowSet.has(model.id) && model.enabled !== false)),
      )
      .map(catalogModelToSelect);

    if (children.length === 0) {
      return scoped.filter((provider) => !isAicoManagedRuntimeProvider(provider.id));
    }

    const managedFromPersonal = scoped.find((provider) =>
      isAicoManagedRuntimeProvider(provider.id),
    );

    const orgProvider: EnabledProviderWithModels = {
      children,
      id: managedFromPersonal?.id ?? DEFAULT_PROVIDER,
      name: managedFromPersonal?.name ?? BRANDING_NAME,
      source: managedFromPersonal?.source ?? 'builtin',
    };

    const byok = aicoManaged
      ? []
      : scoped.filter((provider) => !isAicoManagedRuntimeProvider(provider.id));

    return [orgProvider, ...byok];
  }, [aicoManaged, allowed, catalog, enabledChatModelList, orgId]);

  return { isDataConfirmed, isPending, list };
};

export const useEnabledChatModels = (): EnabledProviderWithModels[] =>
  useEnabledChatModelsState().list;
