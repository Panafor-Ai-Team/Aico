import { BRANDING_NAME, DEFAULT_PROVIDER } from '@lobechat/business-const';
import isEqual from 'fast-deep-equal';
import { useMemo } from 'react';

import {
  filterAicoManagedProviders,
  isAicoManagedRuntimeProvider,
} from '@/features/AicoBilling/isManagedRuntimeProvider';
import { useAicoBillingStore } from '@/features/AicoBilling/store';
import { isAicoManagedProviderMode } from '@/features/Conversation/Error/isAicoManagedProviderMode';
import { filterOrgScopedImageModels } from '@/hooks/orgScopedImageModels';
import { useClientDataSWR } from '@/libs/swr';
import { lambdaClient } from '@/libs/trpc/client';
import { aiModelService } from '@/services/aiModel';
import { aiProviderSelectors, useAiInfraStore } from '@/store/aiInfra';
import { type EnabledProviderWithModels } from '@/types/aiProvider';

/**
 * Enabled image models for the Image Create picker and the chat image-generation
 * confirmation card.
 *
 * - Personal wallet: the user's enabled managed models. In Aico managed mode only
 *   wallet-backed OpenRouter/`aico` providers are shown (same product rule as
 *   chat — never BYOK Google/OpenAI keys).
 * - Org wallet: the team allow-list only, built from the managed catalog, so the
 *   picker can never offer a model the server will reject with
 *   `MODEL_NOT_ALLOWED`. The product's default image generator is always present,
 *   mirroring how Auto is handled for chat.
 */
export const useEnabledImageModels = (): {
  isManagedStatusLoading: boolean;
  list: EnabledProviderWithModels[];
} => {
  const enabledImageModelList = useAiInfraStore(aiProviderSelectors.enabledImageModelList, isEqual);
  const billingContext = useAicoBillingStore((s) => s.context);
  const { data: managedStatus, isLoading } = useClientDataSWR('aico-provider-status', () =>
    lambdaClient.aicoBilling.getManagedProviderStatus.query(),
  );

  const orgId =
    billingContext?.source === 'organization' ? billingContext.organizationId : undefined;

  const { data: allowed } = useClientDataSWR(orgId ? ['aico-my-allowed-models', orgId] : null, () =>
    lambdaClient.organization.getMyAllowedModels.query({ organizationId: orgId! }),
  );

  const { data: catalog } = useClientDataSWR(
    orgId ? ['aico-managed-model-catalog', orgId] : null,
    () => aiModelService.getAiProviderModelList(DEFAULT_PROVIDER),
  );

  const list = useMemo(() => {
    const raw = enabledImageModelList || [];
    // While status loads, expose an empty list so config init waits (avoids
    // locking onto Google defaults before we know Aico is managed-only).
    if (managedStatus === undefined && isLoading) return [];
    const scoped = isAicoManagedProviderMode(managedStatus?.managed)
      ? filterAicoManagedProviders(raw)
      : raw;

    if (!orgId) return scoped;

    // Fail closed while allow-list or catalog loads: hide managed models until known.
    if (!allowed || !catalog) {
      return scoped.filter((provider) => !isAicoManagedRuntimeProvider(provider.id));
    }

    const children = filterOrgScopedImageModels(catalog, allowed.modelIds);
    const byok = scoped.filter((provider) => !isAicoManagedRuntimeProvider(provider.id));

    if (children.length === 0) return byok;

    const managedFromPersonal = scoped.find((provider) =>
      isAicoManagedRuntimeProvider(provider.id),
    );

    const orgProvider: EnabledProviderWithModels = {
      children,
      id: managedFromPersonal?.id ?? DEFAULT_PROVIDER,
      name: managedFromPersonal?.name ?? BRANDING_NAME,
      source: managedFromPersonal?.source ?? 'builtin',
    };

    return [orgProvider, ...byok];
  }, [allowed, catalog, enabledImageModelList, isLoading, managedStatus, orgId]);

  return {
    isManagedStatusLoading: managedStatus === undefined && Boolean(isLoading),
    list,
  };
};
