import { beforeEach, describe, expect, it, vi } from 'vitest';

const loadConfig = async () => import('../config');

describe('isCloudSandboxConfigured', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  // Regression: with the market provider and no Trusted Client credentials every
  // sandbox call comes back 401, which the client turns into a LobeHub sign-in
  // popup. Self-hosted users have no LobeHub account, so the tool must be gated
  // off instead of dead-ending them at an external login page.
  it('reports unconfigured for the default market provider without trusted client credentials', async () => {
    vi.doMock('@/envs/app', () => ({ appEnv: {} }));
    vi.doMock('@/envs/sandbox', () => ({ sandboxEnv: {} }));

    const { isCloudSandboxConfigured } = await loadConfig();

    expect(isCloudSandboxConfigured()).toBe(false);
  });

  it('reports configured for the market provider with trusted client credentials', async () => {
    vi.doMock('@/envs/app', () => ({
      appEnv: {
        MARKET_TRUSTED_CLIENT_ID: 'lobechat-com',
        MARKET_TRUSTED_CLIENT_SECRET: 'trusted-client-secret',
      },
    }));
    vi.doMock('@/envs/sandbox', () => ({ sandboxEnv: { SANDBOX_PROVIDER: 'market' } }));

    const { isCloudSandboxConfigured } = await loadConfig();

    expect(isCloudSandboxConfigured()).toBe(true);
  });

  it('reports configured for a fully configured onlyboxes console', async () => {
    vi.doMock('@/envs/app', () => ({ appEnv: {} }));
    vi.doMock('@/envs/sandbox', () => ({
      sandboxEnv: {
        ONLYBOXES_BASE_URL: 'https://onlyboxes.example.com',
        ONLYBOXES_JIT_SIGNING_KEY: 'jit-signing-key',
        SANDBOX_PROVIDER: 'onlyboxes',
      },
    }));

    const { isCloudSandboxConfigured } = await loadConfig();

    expect(isCloudSandboxConfigured()).toBe(true);
  });

  it('reports unconfigured for an onlyboxes provider missing its signing key', async () => {
    vi.doMock('@/envs/app', () => ({ appEnv: {} }));
    vi.doMock('@/envs/sandbox', () => ({
      sandboxEnv: {
        ONLYBOXES_BASE_URL: 'https://onlyboxes.example.com',
        SANDBOX_PROVIDER: 'onlyboxes',
      },
    }));

    const { isCloudSandboxConfigured } = await loadConfig();

    expect(isCloudSandboxConfigured()).toBe(false);
  });
});
