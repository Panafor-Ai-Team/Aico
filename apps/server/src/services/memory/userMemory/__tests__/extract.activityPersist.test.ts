// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type MemoryExtractionPrivateConfig } from '@/server/globalConfig/parseMemoryExtractionConfig';
import { MemorySourceType } from '@/types/userMemory';

const mocks = vi.hoisted(() => ({
  createActivityMemory: vi.fn(),
}));

vi.mock('@/database/server', () => ({
  getServerDB: vi.fn(async () => ({})),
}));

vi.mock('@/database/models/userMemory', async (importOriginal) => {
  const actual = await importOriginal<{ UserMemoryModel: any }>();
  class MockUserMemoryModel {
    static parseAssociatedLocations = actual.UserMemoryModel.parseAssociatedLocations;
    static parseAssociatedObjects = actual.UserMemoryModel.parseAssociatedObjects;
    static parseAssociatedSubjects = actual.UserMemoryModel.parseAssociatedSubjects;
    static parseDateFromString = actual.UserMemoryModel.parseDateFromString;
    createActivityMemory = mocks.createActivityMemory;
  }
  return { ...actual, UserMemoryModel: MockUserMemoryModel };
});

const { MemoryExtractionExecutor } = await import('../extract');

const createExecutor = () => {
  const provider = 'openrouter';
  const privateConfig: MemoryExtractionPrivateConfig = {
    agentBenchmarkLoCoMo: { model: 'benchmark-1', provider },
    agentGateKeeper: { model: 'gate-1', provider },
    agentLayerExtractor: {
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
    embedding: { model: 'embed-1', provider },
    featureFlags: { enableBenchmarkLoCoMo: false },
    observabilityS3: { enabled: false },
    runner: 'local',
    webhook: {},
  };

  // @ts-ignore accessing private constructor for testing
  return new MemoryExtractionExecutor({ aiProvider: {}, memory: {} } as any, privateConfig);
};

const job = {
  source: MemorySourceType.ChatTopic,
  sourceId: 'topic-1',
  sourceUpdatedAt: new Date('2026-01-02'),
  userId: 'user-1',
} as any;

const activity = (overrides: Record<string, unknown>) => ({
  details: 'Went for a run.',
  memoryCategory: 'health',
  memoryType: 'activity',
  summary: 'Morning run',
  tags: ['exercise'],
  title: 'Morning run',
  withActivity: { narrative: 'Ran 5 km before work.', type: 'exercise' },
  ...overrides,
});

describe('MemoryExtractionExecutor.persistActivityMemories', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createActivityMemory.mockResolvedValue({ memory: { id: 'mem-1' } });
  });

  it('saves an activity whose details came back null instead of failing the topic', async () => {
    const executor = createExecutor();
    vi.spyOn(executor as any, 'generateEmbeddings').mockResolvedValue([]);

    const result = await executor.persistActivityMemories(
      job,
      [],
      { memories: [activity({ details: null })] } as any,
      {} as any,
      'embed-1',
      undefined,
      {} as any,
    );

    expect(result.errors).toEqual([]);
    expect(result.ids).toEqual(['mem-1']);
    expect(mocks.createActivityMemory).toHaveBeenCalledWith(
      expect.objectContaining({ details: '', summary: 'Morning run' }),
    );
  });

  it('still rejects an activity without a summary', async () => {
    const executor = createExecutor();
    vi.spyOn(executor as any, 'generateEmbeddings').mockResolvedValue([]);

    const result = await executor.persistActivityMemories(
      job,
      [],
      { memories: [activity({ summary: null })] } as any,
      {} as any,
      'embed-1',
      undefined,
      {} as any,
    );

    expect(result.ids).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(mocks.createActivityMemory).not.toHaveBeenCalled();
  });
});
