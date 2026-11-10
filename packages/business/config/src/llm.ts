import { MANAGED_PROVIDER_ID } from '@lobechat/business-const';
import type { UserModelProviderConfig } from '@lobechat/types';
import { ModelProvider } from 'model-bank/modelProvider';
import opencodezenModels from 'model-bank/opencodeZen';

const enabledOpenCodeZenModels = opencodezenModels
  .filter(({ enabled }) => enabled)
  .map(({ id }) => id);

const providerDefaults: Partial<
  Record<ModelProvider, { enabled?: boolean; enabledModels?: string[]; fetchOnClient?: boolean }>
> = {
  // Aico: only the active managed surface is enabled by default (BYOK off).
  // Both managed providers stay registered so a switch back is an env change,
  // but exactly one is on — `user_wallets.raw_capacity_micro_usd` is a single
  // pool denominated in the active provider's raw USD and cannot serve two.
  [ModelProvider.CheapVibeCode]: { enabled: MANAGED_PROVIDER_ID === 'cheapvibecode' },
  [ModelProvider.OpenRouter]: { enabled: MANAGED_PROVIDER_ID === 'openrouter' },
  [ModelProvider.LMStudio]: { fetchOnClient: true },
  [ModelProvider.Ollama]: { fetchOnClient: true },
  [ModelProvider.OpenCodeZen]: { enabledModels: enabledOpenCodeZenModels },
};

const genUserLLMConfig = (): UserModelProviderConfig => {
  return Object.values(ModelProvider).reduce((config, provider) => {
    const providerConfig = providerDefaults[provider];

    config[provider] = {
      enabled: providerConfig?.enabled ?? false,
      enabledModels: providerConfig?.enabledModels ?? [],
      ...(providerConfig?.fetchOnClient !== undefined && {
        fetchOnClient: providerConfig.fetchOnClient,
      }),
    };

    return config;
  }, {} as UserModelProviderConfig);
};

export const DEFAULT_LLM_CONFIG = genUserLLMConfig();
