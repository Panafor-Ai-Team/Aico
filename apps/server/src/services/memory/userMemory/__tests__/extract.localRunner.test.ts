// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AsyncTaskErrorType, AsyncTaskStatus } from '@/types/asyncTask';
import { LayersEnum, MemorySourceType } from '@/types/userMemory';

import { MemoryExtractionLocalRunner } from '../extractLocalRunner';

const {
  mockConfig,
  mockCreateExecutor,
  mockExtractTopic,
  mockFindById,
  mockGetTopicsForUser,
  mockIncrementProgress,
  mockIsCancelled,
  mockUpdate,
} = vi.hoisted(() => ({
  mockConfig: { concurrency: undefined as number | undefined },
  mockCreateExecutor: vi.fn(),
  mockExtractTopic: vi.fn(),
  mockFindById: vi.fn(),
  mockGetTopicsForUser: vi.fn(),
  mockIncrementProgress: vi.fn(),
  mockIsCancelled: vi.fn(),
  mockUpdate: vi.fn(),
}));

vi.mock('@/database/server', () => ({
  getServerDB: vi.fn(async () => ({})),
}));

vi.mock('@/database/models/asyncTask', () => ({
  AsyncTaskModel: vi.fn(() => ({
    findById: mockFindById,
    incrementUserMemoryExtractionProgress: mockIncrementProgress,
    isUserMemoryExtractionCancellationRequested: mockIsCancelled,
    update: mockUpdate,
  })),
}));

vi.mock('@/server/globalConfig/parseMemoryExtractionConfig', () => ({
  parseMemoryExtractionConfig: () => ({ concurrency: mockConfig.concurrency }),
}));

vi.mock('../extract', () => ({
  MemoryExtractionExecutor: { create: mockCreateExecutor },
}));

const params = {
  asyncTaskId: 'task-1',
  from: new Date('2024-01-01'),
  to: new Date('2024-02-01'),
  userId: 'user-1',
};

const deferred = () => {
  let resolve!: (value: { extracted: boolean }) => void;
  const promise = new Promise<{ extracted: boolean }>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const page = (size: number, prefix: string) => ({
  cursor: { createdAt: new Date('2024-01-15'), id: `${prefix}-${size - 1}` },
  ids: Array.from({ length: size }, (_, index) => `${prefix}-${index}`),
});

describe('MemoryExtractionLocalRunner.runUserTopics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    mockConfig.concurrency = undefined;
    mockCreateExecutor.mockResolvedValue({
      extractTopic: mockExtractTopic,
      getTopicsForUser: mockGetTopicsForUser,
    });
    mockExtractTopic.mockResolvedValue({ extracted: true });
    mockIsCancelled.mockResolvedValue(false);
    mockFindById.mockResolvedValue({ status: AsyncTaskStatus.Processing });
  });

  it('extracts every topic of every page in two passes and reports progress per topic', async () => {
    mockGetTopicsForUser.mockResolvedValueOnce(page(50, 'a')).mockResolvedValueOnce(page(2, 'b'));

    await MemoryExtractionLocalRunner.runUserTopics(params);

    expect(mockGetTopicsForUser).toHaveBeenCalledTimes(2);
    expect(mockGetTopicsForUser).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ cursor: page(50, 'a').cursor, userId: 'user-1' }),
      50,
    );
    expect(mockExtractTopic).toHaveBeenCalledTimes(104);
    expect(mockExtractTopic).toHaveBeenCalledWith(
      expect.objectContaining({
        asyncTaskId: 'task-1',
        layers: [LayersEnum.Identity],
        reportProgress: false,
        skipExtractedCheck: true,
        source: MemorySourceType.ChatTopic,
        topicId: 'b-1',
        userId: 'user-1',
        userInitiated: true,
      }),
    );
    expect(mockIncrementProgress).toHaveBeenCalledTimes(52);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('runs the identity pass only for topics the first pass extracted', async () => {
    mockGetTopicsForUser.mockResolvedValueOnce(page(2, 'a'));
    mockExtractTopic.mockImplementation(async (job) => ({
      // a-0 was analysed by an earlier run, so the first pass skips it.
      extracted: job.topicId !== 'a-0',
    }));

    await MemoryExtractionLocalRunner.runUserTopics(params);

    const calls = mockExtractTopic.mock.calls.map(([job]) => [
      job.topicId,
      job.layers,
      job.skipExtractedCheck,
    ]);
    expect(calls).toEqual(
      expect.arrayContaining([
        ['a-0', expect.not.arrayContaining([LayersEnum.Identity]), undefined],
        ['a-1', expect.not.arrayContaining([LayersEnum.Identity]), undefined],
        ['a-1', [LayersEnum.Identity], true],
      ]),
    );
    expect(calls).toHaveLength(3);
    expect(mockIncrementProgress).toHaveBeenCalledTimes(2);
  });

  it('extracts up to five topics at once by default', async () => {
    mockGetTopicsForUser.mockResolvedValueOnce(page(7, 'a'));
    const pending = new Map<string, ReturnType<typeof deferred>>();
    let inFlight = 0;
    let maxInFlight = 0;
    mockExtractTopic.mockImplementation(async (job) => {
      if (job.skipExtractedCheck) return { extracted: true };
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const gate = deferred();
      pending.set(job.topicId, gate);
      const result = await gate.promise;
      inFlight -= 1;
      return result;
    });

    const run = MemoryExtractionLocalRunner.runUserTopics(params);
    await flush();
    expect(inFlight).toBe(5);

    while (pending.size > 0) {
      for (const [topicId, gate] of pending) {
        pending.delete(topicId);
        gate.resolve({ extracted: true });
      }
      await flush();
    }
    await run;

    expect(maxInFlight).toBe(5);
    expect(mockIncrementProgress).toHaveBeenCalledTimes(7);
  });

  it('uses MEMORY_USER_MEMORY_CONCURRENCY as the topic limit', async () => {
    mockConfig.concurrency = 2;
    mockGetTopicsForUser.mockResolvedValueOnce(page(4, 'a'));
    let inFlight = 0;
    let maxInFlight = 0;
    mockExtractTopic.mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await flush();
      inFlight -= 1;
      return { extracted: false };
    });

    await MemoryExtractionLocalRunner.runUserTopics(params);

    expect(maxInFlight).toBe(2);
  });

  it('starts no new topic after one fails', async () => {
    mockConfig.concurrency = 2;
    mockGetTopicsForUser.mockResolvedValueOnce(page(5, 'a'));
    mockExtractTopic.mockImplementation(async (job) => {
      await flush();
      if (job.topicId === 'a-0') throw new Error('model 403');
      await flush();
      return { extracted: false };
    });
    mockFindById.mockResolvedValue({ status: AsyncTaskStatus.Error });

    await MemoryExtractionLocalRunner.runUserTopics(params);
    await flush();
    await flush();

    const started = new Set(mockExtractTopic.mock.calls.map(([job]) => job.topicId));
    expect(started).toEqual(new Set(['a-0', 'a-1']));
  });

  it('stops after a failing topic and leaves the error extractTopic already recorded', async () => {
    mockConfig.concurrency = 1;
    mockGetTopicsForUser.mockResolvedValueOnce(page(3, 'a'));
    mockExtractTopic
      .mockResolvedValueOnce({ extracted: true })
      .mockRejectedValueOnce(new Error('model 403'));
    mockFindById.mockResolvedValue({ status: AsyncTaskStatus.Error });

    await expect(MemoryExtractionLocalRunner.runUserTopics(params)).resolves.toBeUndefined();

    expect(mockExtractTopic).toHaveBeenCalledTimes(2);
    expect(mockIncrementProgress).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('marks a still-active task as failed when the run breaks outside extractTopic', async () => {
    mockGetTopicsForUser.mockRejectedValueOnce(new Error('db down'));

    await MemoryExtractionLocalRunner.runUserTopics(params);

    expect(mockUpdate).toHaveBeenCalledWith('task-1', {
      error: expect.objectContaining({ name: AsyncTaskErrorType.ServerError }),
      status: AsyncTaskStatus.Error,
    });
  });

  it('stops when cancellation was requested', async () => {
    mockConfig.concurrency = 1;
    mockGetTopicsForUser.mockResolvedValueOnce(page(3, 'a'));
    mockIsCancelled.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await MemoryExtractionLocalRunner.runUserTopics(params);

    expect(mockExtractTopic).toHaveBeenCalledTimes(2);
    expect(mockIncrementProgress).toHaveBeenCalledTimes(1);
  });
});
