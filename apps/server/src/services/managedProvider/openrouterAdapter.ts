import type { OpenRouterManagementClient } from '@/server/services/openrouter/management';

import type { CreateManagedKeyResult, ManagedKeyInfo, ManagedProviderClient } from './types';

/**
 * Adapts the existing OpenRouter management client to the provider-neutral
 * interface. Deliberately a thin pass-through: OpenRouter is the reference
 * implementation the interface was shaped around, so anything clever here would
 * mean the interface is wrong.
 *
 * `hash` is the whole credential — OpenRouter reads key state with the master
 * management key, so the member's own secret is never needed and never sent.
 */
export class OpenRouterManagedProviderClient implements ManagedProviderClient {
  readonly capabilities = {
    nativePeriodicLimits: true,
    readKeyBySecret: false,
    revoke: true,
    updateLimit: true,
  } as const;

  readonly providerId = 'openrouter' as const;

  constructor(private readonly client: OpenRouterManagementClient) {}

  createKey: ManagedProviderClient['createKey'] = async (params) => {
    // `allowedModels` has no OpenRouter equivalent at key level; per-member model
    // limits are enforced by `AicoManagedPolicy.assertModelAllowed`, which is
    // where they live for every provider.
    const created = await this.client.createKey({
      limitReset: params.limitReset ?? null,
      limitUsd: params.limitUsd,
      name: params.name,
    });
    return created as CreateManagedKeyResult;
  };

  getKey: ManagedProviderClient['getKey'] = async (credential) =>
    (await this.client.getKey(credential.hash)) as ManagedKeyInfo;

  updateKey: NonNullable<ManagedProviderClient['updateKey']> = async (params) =>
    (await this.client.updateKey(params)) as ManagedKeyInfo;

  deleteKey: NonNullable<ManagedProviderClient['deleteKey']> = async (credential) => {
    await this.client.deleteKey(credential.hash);
  };

  /**
   * OpenRouter's account float is read by the existing master monitor through
   * its own credits endpoint, not through the management key routes this client
   * wraps. Kept unimplemented rather than faked so a caller that needs it fails
   * loudly instead of billing against a zero.
   */
  getAccountBalanceUsd: ManagedProviderClient['getAccountBalanceUsd'] = async () => {
    throw new Error(
      'OpenRouter account balance is served by masterMonitor, not the managed-provider client',
    );
  };
}
