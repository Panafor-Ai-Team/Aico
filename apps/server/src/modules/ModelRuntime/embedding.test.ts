// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  env: { AICO_EMBEDDING_OPENROUTER_API_KEY: 'sk-or-test' as string | undefined },
  managed: { id: 'cheapvibecode' as string },
  policy: { isManaged: vi.fn(() => true), resolve: vi.fn(() => 'cheapvibecode') },
}));

vi.mock('@/envs/aico', () => ({ aicoEnv: mocks.env }));
vi.mock('@lobechat/business-const', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@lobechat/business-const')>()),
  get MANAGED_PROVIDER_ID() {
    return mocks.managed.id;
  },
}));
vi.mock('@/server/services/llmGenerationTracing/hook', () => ({
  createLLMGenerationTracingHook: vi.fn(),
}));
vi.mock('@/server/services/aico/ledger/gate', () => ({ assertManagedTrafficAllowed: vi.fn() }));
vi.mock('@/database/models/aiProvider', () => ({
  AiProviderModel: class {
    getAiProviderById = vi.fn(async () => ({ keyVaults: {} }));
  },
}));

import { ModelRuntime } from '@lobechat/model-runtime';

import { initEmbeddingRuntimeFromDB } from './index';

const db = {} as any;

describe('initEmbeddingRuntimeFromDB', () => {
  beforeEach(() => {
    mocks.env.AICO_EMBEDDING_OPENROUTER_API_KEY = 'sk-or-test';
    mocks.managed.id = 'cheapvibecode';
  });

  it('uses the dedicated OpenRouter key instead of the CVC-rewritten managed runtime', async () => {
    const spy = vi.spyOn(ModelRuntime, 'initializeWithProvider');

    const runtime = await initEmbeddingRuntimeFromDB(db, 'user-1', 'openrouter');

    expect(runtime).toBeInstanceOf(ModelRuntime);
    expect(spy).toHaveBeenCalledWith(
      'openrouter',
      expect.objectContaining({ apiKey: 'sk-or-test' }),
      undefined,
    );
    spy.mockRestore();
  });

  it('fails clearly when no dedicated key is configured', async () => {
    mocks.env.AICO_EMBEDDING_OPENROUTER_API_KEY = undefined;

    await expect(initEmbeddingRuntimeFromDB(db, 'user-1', 'openrouter')).rejects.toThrow(
      'EMBEDDING_PROVIDER_NOT_CONFIGURED',
    );
  });
});
