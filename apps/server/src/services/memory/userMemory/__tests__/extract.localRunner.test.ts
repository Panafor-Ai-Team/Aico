// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AsyncTaskErrorType, AsyncTaskStatus } from '@/types/asyncTask';
import { LayersEnum, MemorySourceType } from '@/types/userMemory';

import { MemoryExtractionLocalRunner } from '../extractLocalRunner';

const {
  mockCreateExecutor,
  mockExtractTopic,
  mockFindById,
  mockGetTopicsForUser,
  mockIncrementProgress,
  mockIsCancelled,
  mockUpdate,
} = vi.hoisted(() => ({
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

vi.mock('../extract', () => ({
  MemoryExtractionExecutor: { create: mockCreateExecutor },
}));

const params = {
  asyncTaskId: 'task-1',
  from: new Date('2024-01-01'),
  to: new Date('2024-02-01'),
  userId: 'user-1',
};

const page = (size: number, prefix: string) => ({
  cursor: { createdAt: new Date('2024-01-15'), id: `${prefix}-${size - 1}` },
  ids: Array.from({ length: size }, (_, index) => `${prefix}-${index}`),
});

describe('MemoryExtractionLocalRunner.runUserTopics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
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
        source: MemorySourceType.ChatTopic,
        topicId: 'b-1',
        userId: 'user-1',
        userInitiated: true,
      }),
    );
    expect(mockIncrementProgress).toHaveBeenCalledTimes(52);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('stops after a failing topic and leaves the error extractTopic already recorded', async () => {
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
    mockGetTopicsForUser.mockResolvedValueOnce(page(3, 'a'));
    mockIsCancelled.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await MemoryExtractionLocalRunner.runUserTopics(params);

    expect(mockExtractTopic).toHaveBeenCalledTimes(2);
    expect(mockIncrementProgress).toHaveBeenCalledTimes(1);
  });
});
