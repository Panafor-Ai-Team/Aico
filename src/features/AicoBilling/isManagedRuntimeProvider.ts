import { MANAGED_PROVIDER_IDS } from '@lobechat/business-const';

/** Providers that use Aico wallet → provisioned managed-gateway keys (never BYOK). */
export const AICO_MANAGED_RUNTIME_PROVIDERS = ['aico', ...MANAGED_PROVIDER_IDS] as const;

export type AicoManagedRuntimeProvider = (typeof AICO_MANAGED_RUNTIME_PROVIDERS)[number];

export const isAicoManagedRuntimeProvider = (
  provider: string | null | undefined,
): provider is AicoManagedRuntimeProvider => {
  if (!provider) return false;
  return (AICO_MANAGED_RUNTIME_PROVIDERS as readonly string[]).includes(
    provider.trim().toLowerCase(),
  );
};

/** Keep only wallet-backed provider groups (and drop empty groups). */
export const filterAicoManagedProviders = <T extends { children?: unknown[]; id: string }>(
  list: T[],
): T[] => list.filter((provider) => isAicoManagedRuntimeProvider(provider.id));
