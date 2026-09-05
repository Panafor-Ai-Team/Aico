import { appEnv } from '@/envs/app';
import { sandboxEnv } from '@/envs/sandbox';

import type { SandboxProviderKind } from './types';

export const getSandboxProviderKind = (): SandboxProviderKind => {
  return sandboxEnv.SANDBOX_PROVIDER || 'market';
};

/**
 * Whether the deployment actually has a Cloud Sandbox backend it can reach.
 *
 * - `onlyboxes`: needs its console URL + JIT signing key, otherwise every call
 *   fails inside the provider.
 * - `market`: the Market sandbox authenticates as the current user. Without
 *   Trusted Client credentials the server has no way to do that, so every call
 *   comes back 401 and the client turns that into a LobeHub sign-in popup — a
 *   dead end on a self-hosted deployment whose users have no LobeHub account.
 *   This mirrors `enableLobehubSkill`, gated on the same credentials.
 *
 * Consumers use this to keep the Cloud Sandbox tool out of the model's toolset
 * entirely, so it is never proposed, approved, and then dead-ended.
 *
 * Lives in its own leaf module (env only) so config-level callers don't pull in
 * the provider implementations and their SDKs.
 */
export const isCloudSandboxConfigured = (): boolean => {
  switch (getSandboxProviderKind()) {
    case 'onlyboxes': {
      return !!(sandboxEnv.ONLYBOXES_BASE_URL && sandboxEnv.ONLYBOXES_JIT_SIGNING_KEY);
    }

    case 'market': {
      return !!(appEnv.MARKET_TRUSTED_CLIENT_ID && appEnv.MARKET_TRUSTED_CLIENT_SECRET);
    }
  }
};
