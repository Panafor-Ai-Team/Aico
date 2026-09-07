import { BRANDING_NAME } from '@lobechat/business-const';
import { DEFAULT_MODEL_PROVIDER_LIST } from 'model-bank/modelProviders';

import { isCustomBranding } from '@/const/version';
import { isAicoManagedRuntimeProvider } from '@/features/AicoBilling/isManagedRuntimeProvider';

export const useProviderName = (provider: string) => {
  if (isAicoManagedRuntimeProvider(provider)) return BRANDING_NAME;
  if (isCustomBranding && provider?.trim().toLowerCase() === 'lobehub') return BRANDING_NAME;
  const providerCard = DEFAULT_MODEL_PROVIDER_LIST.find((p) => p.id === provider);

  return providerCard?.name || provider;
};
