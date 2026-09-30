import { DEFAULT_MODEL_PROVIDER_LIST } from 'model-bank/modelProviders';

import {
  formatBrandedProviderId,
  isBrandedOpenRouterProvider,
} from '@/components/Branding/brandedModelId';

export const useProviderName = (provider: string) => {
  if (isBrandedOpenRouterProvider(provider)) return formatBrandedProviderId(provider);

  const providerCard = DEFAULT_MODEL_PROVIDER_LIST.find((p) => p.id === provider);

  return providerCard?.name || provider;
};
