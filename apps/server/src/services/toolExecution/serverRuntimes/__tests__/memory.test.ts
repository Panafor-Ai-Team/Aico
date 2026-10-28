import type { LobeChatDatabase } from '@lobechat/database';
import { describe, expect, it, vi } from 'vitest';

import type { ToolExecutionContext } from '../../types';

const mocks = vi.hoisted(() => ({
  embeddings: vi.fn(),
  getUserWallet: vi.fn(async () => null),
  initEmbeddingRuntimeFromDB: vi.fn(),
  initModelRuntimeWithUserPayload: vi.fn(),
  searchMemory: vi.fn(),
}));

vi.mock('@/database/models/aicoBilling', () => ({
  AicoBillingModel: vi.fn().mockImplementation(() => ({
    getUserWallet: mocks.getUserWallet,
  })),
}));

vi.mock('@/database/models/userMemory', () => ({
  UserMemoryModel: vi.fn().mockImplementation(() => ({
    searchMemory: mocks.searchMemory,
  })),
}));

vi.mock('@/database/schemas', () => ({
  userSettings: { id: 'id' },
}));

vi.mock('@/server/globalConfig', () => ({
  getServerDefaultFilesConfig: vi.fn(() => ({
    embeddingModel: { model: 'default-embedding-model', provider: 'default-provider' },
  })),
}));

vi.mock('@/server/modules/ModelRuntime', () => ({
  initEmbeddingRuntimeFromDB: mocks.initEmbeddingRuntimeFromDB,
  initModelRuntimeWithUserPayload: mocks.initModelRuntimeWithUserPayload,
}));

vi.mock('@/server/services/agentSignal/procedure', () => ({
  emitToolOutcomeSafely: vi.fn(),
  resolveToolOutcomeScope: vi.fn(() => ({ scope: 'user', scopeKey: 'user-1' })),
}));

vi.mock('@/server/services/agentSignal/store/adapters/redis/policyStateStore', () => ({
  redisPolicyStateStore: {},
}));

const { memoryRuntime } = await import('../memory');

const createContext = (): ToolExecutionContext => ({
  memoryEmbeddingRuntime: {
    model: 'server-embedding-model',
    payload: {
      apiKey: 'server-key',
      baseURL: 'https://embedding.example.com/v1',
    },
    provider: 'server-provider',
  },
  serverDB: {
    query: {
      userSettings: {
        findFirst: vi.fn(async () => undefined),
      },
    },
  } as unknown as LobeChatDatabase,
  toolManifestMap: {},
  userId: 'synthetic-user',
});

describe('memoryRuntime', () => {
  it('uses server-owned embedding runtime for memory search', async () => {
    mocks.embeddings.mockResolvedValueOnce([[0.1, 0.2, 0.3]]);
    mocks.initModelRuntimeWithUserPayload.mockReturnValueOnce({
      embeddings: mocks.embeddings,
    });
    mocks.searchMemory.mockResolvedValueOnce({
      activities: [],
      contexts: [],
      experiences: [],
      identities: [],
      preferences: [],
    });

    const runtime = await memoryRuntime.factory(createContext());

    await runtime.searchUserMemory({ queries: ['renewal timeline'] });

    expect(mocks.initModelRuntimeWithUserPayload).toHaveBeenCalledWith(
      'server-provider',
      {
        apiKey: 'server-key',
        baseURL: 'https://embedding.example.com/v1',
      },
      { userId: 'synthetic-user' },
    );
    expect(mocks.initEmbeddingRuntimeFromDB).not.toHaveBeenCalled();
    expect(mocks.embeddings).toHaveBeenCalledWith(
      expect.objectContaining({
        input: ['renewal timeline'],
        model: 'server-embedding-model',
      }),
      expect.objectContaining({ user: 'synthetic-user' }),
    );
    expect(mocks.searchMemory).toHaveBeenCalledWith(
      expect.objectContaining({ queries: ['renewal timeline'] }),
      [[0.1, 0.2, 0.3]],
    );
  });

  it('authorizes the default embedding runtime with billing context and embedding model id', async () => {
    // Regression: the managed authorize boundary (OR-003) requires an explicit
    // modelId. The default branch passed neither billing nor model, so every
    // memory search on a managed deployment failed before embedding.
    mocks.initEmbeddingRuntimeFromDB.mockResolvedValueOnce({
      embeddings: mocks.embeddings,
    });
    mocks.embeddings.mockResolvedValueOnce([[0.1, 0.2, 0.3]]);
    mocks.searchMemory.mockResolvedValueOnce({
      activities: [],
      contexts: [],
      experiences: [],
      identities: [],
      preferences: [],
    });

    const { memoryEmbeddingRuntime: _omitted, ...contextWithoutRuntime } = createContext();
    const runtime = await memoryRuntime.factory(contextWithoutRuntime as any);
    await runtime.searchUserMemory({ queries: ['renewal timeline'] });

    expect(mocks.initEmbeddingRuntimeFromDB).toHaveBeenCalledWith(
      expect.anything(),
      'synthetic-user',
      'default-provider',
      undefined,
      {
        billingContext: { source: 'personal' },
        modelId: 'default-embedding-model',
      },
    );
  });
});
