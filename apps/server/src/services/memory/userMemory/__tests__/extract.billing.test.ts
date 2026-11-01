// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type MemoryExtractionPrivateConfig } from '@/server/globalConfig/parseMemoryExtractionConfig';
import { AicoManagedPolicyError } from '@/server/services/aico/managedPolicy';
import { MemorySourceType } from '@/types/userMemory';

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  initBilledMemoryRuntime: vi.fn(),
  resolveMemoryBillingContext: vi.fn(),
}));

vi.mock('@/database/server', () => ({
  getServerDB: vi.fn(async () => ({ query: { topics: { findFirst: mocks.findFirst } } })),
}));

vi.mock('@/server/services/aico/memoryBilling', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  initBilledMemoryRuntime: mocks.initBilledMemoryRuntime,
  resolveMemoryBillingContext: mocks.resolveMemoryBillingContext,
}));

vi.mock('@/database/models/user', async (importOriginal) => {
  const actual = await importOriginal<{ UserModel: any }>();
  class MockUserModel {
    static listUsersForHourlyMemoryExtractor = actual.UserModel.listUsersForHourlyMemoryExtractor;
    getUserState = vi.fn(async () => ({ firstName: 'Ada', settings: {} }));
  }
  return { ...actual, UserModel: MockUserModel };
});

const { MemoryExtractionExecutor } = await import('../extract');

const createExecutor = (provider: string) => {
  const privateConfig: MemoryExtractionPrivateConfig = {
    agentBenchmarkLoCoMo: { model: 'benchmark-1', provider },
    agentGateKeeper: { model: 'gate-1', provider },
    agentLayerExtractor: {
      contextLimit: 2048,
      layers: {
        activity: 'layer-act',
        context: 'layer-ctx',
        experience: 'layer-exp',
        identity: 'layer-id',
        preference: 'layer-pref',
      },
      model: 'layer-1',
      provider,
    },
    agentPersonaWriter: { model: 'persona-1', provider },
    concurrency: 1,
    embedding: { model: 'embed-1', provider },
    featureFlags: { enableBenchmarkLoCoMo: false },
    observabilityS3: { enabled: false },
    webhook: {},
  };

  // @ts-ignore accessing private constructor for testing
  return new MemoryExtractionExecutor({ aiProvider: {}, memory: {} } as any, privateConfig);
};

const fundsError = () => new AicoManagedPolicyError('PERSONAL_FUNDS_UNAVAILABLE');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveMemoryBillingContext.mockResolvedValue({ source: 'personal' });
  mocks.initBilledMemoryRuntime.mockImplementation(async ({ modelId }) => ({ modelId }));
});

describe('MemoryExtractionExecutor billing', () => {
  it('builds managed memory runtimes billed to the user', async () => {
    const executor = createExecutor('openrouter');
    const config = (executor as any).resolveUserMemoryServiceConfig();

    const runtimes = await (executor as any).getRuntime('user-1', config, {}, 'ws-1');

    expect(mocks.resolveMemoryBillingContext).toHaveBeenCalledTimes(1);
    expect(mocks.initBilledMemoryRuntime.mock.calls.map(([call]) => call)).toEqual([
      expect.objectContaining({
        billingContext: { source: 'personal' },
        kind: 'embedding',
        modelId: 'embed-1',
        provider: 'openrouter',
        userId: 'user-1',
        workspaceId: 'ws-1',
      }),
      expect.objectContaining({ kind: 'generation', modelId: 'gate-1' }),
      expect.objectContaining({ kind: 'generation', modelId: 'layer-1' }),
    ]);
    expect(runtimes.gatekeeper).toEqual({ modelId: 'gate-1' });
  });

  it('keeps BYOK providers off the managed billing path', async () => {
    const executor = createExecutor('openai');
    const config = (executor as any).resolveUserMemoryServiceConfig();

    await (executor as any).getRuntime('user-1', config, {
      openai: { apiKey: 'sk-user' },
    });

    expect(mocks.initBilledMemoryRuntime).not.toHaveBeenCalled();
    expect(mocks.resolveMemoryBillingContext).not.toHaveBeenCalled();
  });

  describe('canAffordExtraction', () => {
    const prepare = (executor: ReturnType<typeof createExecutor>) => {
      vi.spyOn(executor as any, 'getAiProviderRuntimeState').mockResolvedValue({});
      vi.spyOn(executor as any, 'resolveRuntimeKeyVaults').mockResolvedValue({});
    };

    it('is true when the managed policy authorizes the user', async () => {
      const executor = createExecutor('openrouter');
      prepare(executor);

      await expect(executor.canAffordExtraction('user-1')).resolves.toBe(true);
    });

    it('is false when the billing source cannot pay', async () => {
      const executor = createExecutor('openrouter');
      prepare(executor);
      mocks.initBilledMemoryRuntime.mockRejectedValue(fundsError());

      await expect(executor.canAffordExtraction('user-1')).resolves.toBe(false);
    });

    it('rethrows errors that are not about funds', async () => {
      const executor = createExecutor('openrouter');
      prepare(executor);
      mocks.initBilledMemoryRuntime.mockRejectedValue(new Error('db down'));

      await expect(executor.canAffordExtraction('user-1')).rejects.toThrow('db down');
    });
  });

  describe('extractTopic funds refusal', () => {
    const job = {
      layers: [],
      source: MemorySourceType.ChatTopic,
      topicId: 'topic-1',
      userId: 'user-1',
    };

    const prepare = () => {
      const executor = createExecutor('openrouter');
      mocks.findFirst.mockResolvedValue({
        createdAt: new Date('2026-01-01'),
        id: 'topic-1',
        metadata: {},
        updatedAt: new Date('2026-01-02'),
        userId: 'user-1',
      });
      vi.spyOn(executor as any, 'getAiProviderRuntimeState').mockResolvedValue({});
      vi.spyOn(executor as any, 'resolveRuntimeKeyVaults').mockResolvedValue({});
      vi.spyOn(executor as any, 'getRuntime').mockRejectedValue(fundsError());
      return executor;
    };

    it('defers background extraction without failing the topic', async () => {
      const executor = prepare();
      const recordJobMetrics = vi.spyOn(executor as any, 'recordJobMetrics');

      const result = await executor.extractTopic(job);

      expect(result).toMatchObject({ deferred: true, extracted: false, memoryIds: [] });
      expect(recordJobMetrics).not.toHaveBeenCalledWith(
        expect.anything(),
        'failed',
        expect.anything(),
      );
    });

    it('surfaces the refusal for user-initiated extraction', async () => {
      const executor = prepare();

      await expect(executor.extractTopic({ ...job, userInitiated: true })).rejects.toBeInstanceOf(
        AicoManagedPolicyError,
      );
    });
  });
});
