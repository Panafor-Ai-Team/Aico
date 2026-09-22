import { MANAGED_PROVIDER_ID, type ManagedProviderId } from '@lobechat/business-const';

import { aicoEnv } from '@/envs/aico';
import { createOpenRouterManagementClient } from '@/server/services/openrouter/management';

import {
  HttpCheapVibeCodeClient,
  MockCheapVibeCodeClient,
  RemoteCheapVibeCodeClient,
} from './cheapvibecode';
import { OpenRouterManagedProviderClient } from './openrouterAdapter';
import type { ManagedProviderClient } from './types';

export {
  CheapVibeCodeAmbiguousEditError,
  cvcTokensToUsd,
  HttpCheapVibeCodeClient,
  isManagedKeyCapacityError,
  MANAGED_KEY_CAPACITY,
  ManagedKeyCapacityError,
  MockCheapVibeCodeClient,
  RemoteCheapVibeCodeClient,
  usdToCvcTokens,
} from './cheapvibecode';
export { OpenRouterManagedProviderClient } from './openrouterAdapter';
export * from './types';

/**
 * CVC's primary key is BOTH the management credential and a fully funded
 * inference key: a leak spends the account float directly rather than merely
 * minting keys. It gets the same containment `OPENROUTER_MANAGEMENT_API_KEY` has
 * — control plane only — enforced here rather than by convention, and at every
 * NODE_ENV so a staging misconfiguration is caught before it reaches production.
 */
const assertCredentialContainment = () => {
  if (!aicoEnv.AICO_IS_CONTROL_PLANE && aicoEnv.CHEAPVIBECODE_MANAGEMENT_API_KEY) {
    throw new Error(
      'CHEAPVIBECODE_MANAGEMENT_API_KEY must not be set on the product server — configure AICO_CONTROL_PLANE_URL + AICO_CONTROL_PLANE_SERVICE_TOKEN instead.',
    );
  }
};

const createCheapVibeCodeClient = (forceMock: boolean): ManagedProviderClient => {
  if (forceMock) return new MockCheapVibeCodeClient();

  assertCredentialContainment();

  const isProduction = process.env.NODE_ENV === 'production';
  const isControlPlane = aicoEnv.AICO_IS_CONTROL_PLANE;

  // Product path: mint through the control plane, read per-key balance directly.
  if (!isControlPlane) {
    const url = aicoEnv.AICO_CONTROL_PLANE_URL;
    const token = aicoEnv.AICO_CONTROL_PLANE_SERVICE_TOKEN;
    if (url && token) return new RemoteCheapVibeCodeClient(url, token);
  }

  if (aicoEnv.CHEAPVIBECODE_MANAGEMENT_API_KEY) {
    return new HttpCheapVibeCodeClient(aicoEnv.CHEAPVIBECODE_MANAGEMENT_API_KEY);
  }

  // The mock is a non-production QA convenience. Mirrors the OpenRouter factory
  // so the two providers cannot diverge on what is permitted in production.
  if (
    aicoEnv.AICO_OPENROUTER_MOCK &&
    (!isProduction || (isControlPlane && process.env.AICO_ALLOW_INSECURE_CONTROL_PLANE === '1'))
  ) {
    return new MockCheapVibeCodeClient();
  }

  if (isProduction) {
    throw new Error(
      isControlPlane
        ? 'CHEAPVIBECODE_MANAGEMENT_API_KEY is required on the control plane in production — refusing to mock CheapVibeCode calls.'
        : 'AICO_CONTROL_PLANE_URL and AICO_CONTROL_PLANE_SERVICE_TOKEN are required on the product server in production.',
    );
  }

  return new MockCheapVibeCodeClient();
};

export const createManagedProviderClient = (
  options: { forceMock?: boolean; providerId?: ManagedProviderId } = {},
): ManagedProviderClient => {
  const providerId = options.providerId ?? MANAGED_PROVIDER_ID;
  const forceMock = options.forceMock ?? false;

  if (providerId === 'cheapvibecode') return createCheapVibeCodeClient(forceMock);

  return new OpenRouterManagedProviderClient(createOpenRouterManagementClient({ forceMock }));
};

let singleton: ManagedProviderClient | null = null;

/** The client for whichever provider `AICO_MANAGED_PROVIDER` makes live. */
export const getManagedProviderClient = (): ManagedProviderClient => {
  singleton ??= createManagedProviderClient();
  return singleton;
};

export const __resetManagedProviderClientForTests = () => {
  singleton = null;
};
