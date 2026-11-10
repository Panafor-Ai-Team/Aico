import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetManagedProviderClientForTests,
  createManagedProviderClient,
  HttpCheapVibeCodeClient,
  MockCheapVibeCodeClient,
  OpenRouterManagedProviderClient,
  RemoteCheapVibeCodeClient,
} from './index';

// vi.mock is hoisted above module scope, so the mutable env it closes over has
// to be hoisted with it.
const { env } = vi.hoisted(() => ({
  env: {
    AICO_CONTROL_PLANE_SERVICE_TOKEN: undefined as string | undefined,
    AICO_CONTROL_PLANE_URL: undefined as string | undefined,
    AICO_CVC_TOKENS_PER_USD: 25_000_000,
    AICO_IS_CONTROL_PLANE: false,
    AICO_OPENROUTER_MOCK: false,
    AICO_TOMAN_PER_USD: 50_000,
    CHEAPVIBECODE_BASE_URL: 'https://cheapvibecode.ru',
    CHEAPVIBECODE_MANAGEMENT_API_KEY: undefined as string | undefined,
    OPENROUTER_MANAGEMENT_API_KEY: undefined as string | undefined,
  },
}));

vi.mock('@/envs/aico', () => ({ aicoEnv: env }));

beforeEach(() => {
  __resetManagedProviderClientForTests();
  Object.assign(env, {
    AICO_CONTROL_PLANE_SERVICE_TOKEN: undefined,
    AICO_CONTROL_PLANE_URL: undefined,
    AICO_IS_CONTROL_PLANE: false,
    AICO_OPENROUTER_MOCK: false,
    CHEAPVIBECODE_MANAGEMENT_API_KEY: undefined,
    OPENROUTER_MANAGEMENT_API_KEY: undefined,
  });
  vi.stubEnv('NODE_ENV', 'test');
});

afterEach(() => {
  // vi.unstubAllEnvs restores NODE_ENV, which is read-only on ProcessEnv.
  vi.unstubAllEnvs();
});

describe('createManagedProviderClient', () => {
  it('still returns the OpenRouter adapter — the live provider is unchanged', () => {
    const client = createManagedProviderClient({ forceMock: true, providerId: 'openrouter' });
    expect(client).toBeInstanceOf(OpenRouterManagedProviderClient);
    expect(client.providerId).toBe('openrouter');
    expect(client.capabilities).toEqual({
      nativePeriodicLimits: true,
      readKeyBySecret: false,
      revoke: true,
      updateLimit: true,
    });
  });

  describe('credential containment', () => {
    it('refuses to build a CVC client when the primary key is on the product server', () => {
      env.CHEAPVIBECODE_MANAGEMENT_API_KEY = 'sk-cvc-primary';
      env.AICO_IS_CONTROL_PLANE = false;

      expect(() => createManagedProviderClient({ providerId: 'cheapvibecode' })).toThrow(
        /must not be set on the product server/,
      );
    });

    it('allows the primary key on the control plane', () => {
      env.CHEAPVIBECODE_MANAGEMENT_API_KEY = 'sk-cvc-primary';
      env.AICO_IS_CONTROL_PLANE = true;

      expect(createManagedProviderClient({ providerId: 'cheapvibecode' })).toBeInstanceOf(
        HttpCheapVibeCodeClient,
      );
    });

    it('does not fire on the OpenRouter path — the guard is CVC-specific', () => {
      env.CHEAPVIBECODE_MANAGEMENT_API_KEY = 'sk-cvc-primary';

      expect(() =>
        createManagedProviderClient({ forceMock: true, providerId: 'openrouter' }),
      ).not.toThrow();
    });

    it('is skipped for the mock, which never holds a credential', () => {
      env.CHEAPVIBECODE_MANAGEMENT_API_KEY = 'sk-cvc-primary';

      expect(
        createManagedProviderClient({ forceMock: true, providerId: 'cheapvibecode' }),
      ).toBeInstanceOf(MockCheapVibeCodeClient);
    });
  });

  it('proxies through the control plane when it is configured', () => {
    env.AICO_CONTROL_PLANE_URL = 'https://control.aico.test';
    env.AICO_CONTROL_PLANE_SERVICE_TOKEN = 'svc-token';

    expect(createManagedProviderClient({ providerId: 'cheapvibecode' })).toBeInstanceOf(
      RemoteCheapVibeCodeClient,
    );
  });

  describe('production refuses to silently mock', () => {
    it('on the product server with no control plane configured', () => {
      vi.stubEnv('NODE_ENV', 'production');
      env.AICO_OPENROUTER_MOCK = true;

      expect(() => createManagedProviderClient({ providerId: 'cheapvibecode' })).toThrow(
        /AICO_CONTROL_PLANE_URL and AICO_CONTROL_PLANE_SERVICE_TOKEN are required/,
      );
    });

    it('on the control plane with no primary key', () => {
      vi.stubEnv('NODE_ENV', 'production');
      env.AICO_IS_CONTROL_PLANE = true;
      env.AICO_OPENROUTER_MOCK = true;

      expect(() => createManagedProviderClient({ providerId: 'cheapvibecode' })).toThrow(
        /CHEAPVIBECODE_MANAGEMENT_API_KEY is required/,
      );
    });
  });

  it('falls back to the mock outside production', () => {
    env.AICO_OPENROUTER_MOCK = true;

    expect(createManagedProviderClient({ providerId: 'cheapvibecode' })).toBeInstanceOf(
      MockCheapVibeCodeClient,
    );
  });
});
