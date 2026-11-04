import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  UserPersonaVersionNotFoundError,
  UserPersonaVersionSnapshotMissingError,
} from '@/database/models/userMemory/persona';
import { userMemoryRouter } from '@/server/routers/lambda/userMemory';
import { AsyncTaskErrorType, AsyncTaskStatus, AsyncTaskType } from '@/types/asyncTask';
import { MemorySourceType } from '@/types/userMemory';

const mockFindActiveByType = vi.fn();
const mockCreate = vi.fn();
const mockUpdate = vi.fn();
const mockFindById = vi.fn();

const mockCountTopicsForMemoryExtractor = vi.fn();
const mockDeleteAll = vi.fn();
const mockDeletePersona = vi.fn();
const mockListPersonaVersions = vi.fn();
const mockRestorePersonaVersion = vi.fn();
const { mockTriggerProcessUsers } = vi.hoisted(() => ({
  mockTriggerProcessUsers: vi.fn(),
}));
const mockActivityUpdate = vi.fn();
const mockContextUpdate = vi.fn();
const mockExperienceUpdate = vi.fn();
const mockPreferenceUpdate = vi.fn();
const mockUpdateIdentityEntry = vi.fn();
const { mockEmbed, mockGetEmbeddingRuntime } = vi.hoisted(() => ({
  mockEmbed: vi.fn(),
  mockGetEmbeddingRuntime: vi.fn(),
}));

vi.mock('@/database/models/asyncTask', () => ({
  AsyncTaskModel: vi.fn(() => ({
    create: mockCreate,
    findById: mockFindById,
    findActiveByType: mockFindActiveByType,
    update: mockUpdate,
  })),
  initUserMemoryExtractionMetadata: vi.fn((metadata) => metadata),
}));

vi.mock('@/database/models/topic', () => ({
  TopicModel: vi.fn(() => ({
    countTopicsForMemoryExtractor: mockCountTopicsForMemoryExtractor,
  })),
}));

vi.mock('@/database/models/userMemory', () => ({
  UserMemoryActivityModel: vi.fn(() => ({ update: mockActivityUpdate })),
  UserMemoryContextModel: vi.fn(() => ({ update: mockContextUpdate })),
  UserMemoryExperienceModel: vi.fn(() => ({ update: mockExperienceUpdate })),
  UserMemoryIdentityModel: vi.fn(() => ({})),
  UserMemoryModel: vi.fn(() => ({
    deleteAll: mockDeleteAll,
    updateIdentityEntry: mockUpdateIdentityEntry,
  })),
  UserMemoryPreferenceModel: vi.fn(() => ({ update: mockPreferenceUpdate })),
}));

vi.mock('@/server/services/memory/userMemory/embeddingRuntime', () => ({
  createUserMemoryEmbedder: vi.fn(() => mockEmbed),
  getUserMemoryEmbeddingRuntime: mockGetEmbeddingRuntime,
}));

vi.mock('@/database/models/userMemory/persona', () => ({
  UserPersonaVersionNotFoundError: class UserPersonaVersionNotFoundError extends Error {},
  UserPersonaVersionSnapshotMissingError: class UserPersonaVersionSnapshotMissingError extends Error {},
  UserPersonaModel: vi.fn(() => ({
    deletePersona: mockDeletePersona,
    listVersions: mockListPersonaVersions,
    restoreVersion: mockRestorePersonaVersion,
  })),
}));

vi.mock('@/envs/app', () => ({
  appEnv: {
    APP_URL: 'https://example.com',
    INTERNAL_APP_URL: 'https://internal.example.com',
  },
}));

vi.mock('@/server/globalConfig/parseMemoryExtractionConfig', () => ({
  parseMemoryExtractionConfig: vi.fn(() => ({
    webhook: { baseUrl: 'https://internal.example.com' },
    upstashWorkflowExtraHeaders: { 'x-test': 'ok' },
  })),
}));

vi.mock('@/server/services/memory/userMemory/extract', () => ({
  MemoryExtractionWorkflowService: {
    triggerProcessUsers: mockTriggerProcessUsers,
  },
  buildWorkflowPayloadInput: (payload: any) => payload,
  normalizeMemoryExtractionPayload: (payload: any) => payload,
}));

const createCaller = (ctxOverrides: Partial<any> = {}) => {
  const ctx = {
    serverDB: {} as any,
    userId: 'user-1',
    ...ctxOverrides,
  };

  return userMemoryRouter.createCaller(ctx);
};

describe('userMemoryRouter.requestMemoryFromChatTopic', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTriggerProcessUsers.mockResolvedValue({ workflowRunId: 'workflow-run-1' });
  });

  it('dedupes when an active task exists', async () => {
    mockFindActiveByType.mockResolvedValue({
      id: 'existing-task',
      metadata: { progress: { completedTopics: 0, totalTopics: 1 } },
      status: AsyncTaskStatus.Pending,
    });

    const caller = createCaller();
    const result = await caller.requestMemoryFromChatTopic({});

    expect(result).toEqual({
      deduped: true,
      id: 'existing-task',
      metadata: { progress: { completedTopics: 0, totalTopics: 1 } },
      status: AsyncTaskStatus.Pending,
    });
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockTriggerProcessUsers).not.toHaveBeenCalled();
  });

  it('creates task and triggers workflow with user context and dates', async () => {
    mockFindActiveByType.mockResolvedValue(undefined);
    mockCreate.mockResolvedValue('new-task');
    mockCountTopicsForMemoryExtractor.mockResolvedValue(2);

    const caller = createCaller();
    const result = await caller.requestMemoryFromChatTopic({
      fromDate: new Date('2024-01-01'),
      toDate: new Date('2024-02-01'),
    });

    expect(mockCreate).toHaveBeenCalledWith({
      metadata: {
        progress: { completedTopics: 0, totalTopics: 2 },
        range: {
          from: new Date('2024-01-01').toISOString(),
          to: new Date('2024-02-01').toISOString(),
        },
        source: 'chat_topic',
      },
      status: AsyncTaskStatus.Pending,
      type: AsyncTaskType.UserMemoryExtractionWithChatTopic,
    });
    expect(mockTriggerProcessUsers).toHaveBeenCalledWith(
      expect.objectContaining({
        asyncTaskId: 'new-task',
        baseUrl: 'https://internal.example.com',
        fromDate: new Date('2024-01-01'),
        sources: [MemorySourceType.ChatTopic],
        toDate: new Date('2024-02-01'),
        userIds: ['user-1'],
        userInitiated: true,
      }),
      { extraHeaders: { 'x-test': 'ok' } },
    );
    expect(mockUpdate).toHaveBeenCalledWith('new-task', {
      metadata: expect.objectContaining({
        control: {
          upstash: {
            workflowRunIds: ['workflow-run-1'],
          },
        },
      }),
    });
    expect(result).toMatchObject({
      deduped: false,
      id: 'new-task',
      status: AsyncTaskStatus.Pending,
    });
  });

  it('returns success immediately when no topics', async () => {
    mockFindActiveByType.mockResolvedValue(undefined);
    mockCountTopicsForMemoryExtractor.mockResolvedValue(0);
    mockCreate.mockResolvedValue('empty-task');

    const caller = createCaller();
    const result = await caller.requestMemoryFromChatTopic({});

    expect(result).toEqual({
      deduped: false,
      id: 'empty-task',
      metadata: {
        progress: { completedTopics: 0, totalTopics: 0 },
        range: { from: undefined, to: undefined },
        source: 'chat_topic',
      },
      status: AsyncTaskStatus.Success,
    });
    expect(mockTriggerProcessUsers).not.toHaveBeenCalled();
  });

  it('throws on invalid date range', async () => {
    const caller = createCaller();
    await expect(
      caller.requestMemoryFromChatTopic({
        fromDate: new Date('2024-02-02'),
        toDate: new Date('2024-01-01'),
      }),
    ).rejects.toBeInstanceOf(TRPCError);
  });
});

describe('userMemoryRouter.getMemoryExtractionTask', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('returns null when no active task', async () => {
    mockFindActiveByType.mockResolvedValue(undefined);

    const caller = createCaller();
    const result = await caller.getMemoryExtractionTask();

    expect(result).toBeNull();
  });

  it('returns active task with normalized metadata', async () => {
    mockFindActiveByType.mockResolvedValue({
      id: 'task-1',
      metadata: {
        progress: { completedTopics: 1, totalTopics: 4 },
        source: 'chat_topic',
      },
      status: AsyncTaskStatus.Processing,
      userId: 'user-1',
    });

    const caller = createCaller();
    const result = await caller.getMemoryExtractionTask();

    expect(result).toEqual({
      error: undefined,
      id: 'task-1',
      metadata: {
        progress: { completedTopics: 1, totalTopics: 4 },
        range: undefined,
        source: 'chat_topic',
      },
      status: AsyncTaskStatus.Processing,
    });
  });

  it('fetches by task id when provided', async () => {
    mockFindActiveByType.mockResolvedValue(undefined);
    mockFindById.mockResolvedValue({
      id: 'a0a0a0a0-a0a0-4a0a-a0a0-a0a0a0a0a0a0',
      metadata: {
        progress: { completedTopics: 2, totalTopics: 8 },
        source: 'chat_topic',
      },
      status: AsyncTaskStatus.Pending,
      userId: 'user-1',
    });

    const caller = createCaller();
    const result = await caller.getMemoryExtractionTask({
      taskId: 'a0a0a0a0-a0a0-4a0a-a0a0-a0a0a0a0a0a0',
    });

    expect(mockFindById).toHaveBeenCalledWith('a0a0a0a0-a0a0-4a0a-a0a0-a0a0a0a0a0a0');
    expect(result?.id).toBe('a0a0a0a0-a0a0-4a0a-a0a0-a0a0a0a0a0a0');
  });

  it('marks active task as error when topic-based timeout is exceeded', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-03-01T01:00:00.000Z'));

    mockFindActiveByType.mockResolvedValue({
      createdAt: new Date('2024-03-01T00:00:00.000Z'),
      id: 'task-timeout',
      metadata: {
        progress: { completedTopics: 1, totalTopics: 6 },
        source: 'chat_topic',
      },
      status: AsyncTaskStatus.Processing,
      userId: 'user-1',
    });

    const caller = createCaller();
    const result = await caller.getMemoryExtractionTask();

    expect(mockUpdate).toHaveBeenCalledWith(
      'task-timeout',
      expect.objectContaining({
        error: expect.objectContaining({
          body: expect.objectContaining({
            detail: expect.stringContaining('timed out after 30 minutes'),
          }),
          name: AsyncTaskErrorType.Timeout,
        }),
        status: AsyncTaskStatus.Error,
      }),
    );
    expect(result).toEqual({
      error: expect.objectContaining({
        body: expect.objectContaining({
          detail: expect.stringContaining('timed out after 30 minutes'),
        }),
        name: AsyncTaskErrorType.Timeout,
      }),
      id: 'task-timeout',
      metadata: {
        progress: { completedTopics: 1, totalTopics: 6 },
        range: undefined,
        source: 'chat_topic',
      },
      status: AsyncTaskStatus.Error,
    });
  });
});

describe('userMemoryRouter.deleteAll', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('purges all user memories through the aggregate model', async () => {
    mockDeleteAll.mockResolvedValue(undefined);
    mockDeletePersona.mockResolvedValue(undefined);

    const caller = createCaller();
    const result = await caller.deleteAll();

    expect(mockDeleteAll).toHaveBeenCalledOnce();
    expect(mockDeletePersona).toHaveBeenCalledOnce();
    expect(result).toEqual({ success: true });
  });
});

describe('userMemoryRouter manual edits', () => {
  const vectorOf = (text: string) => [text.length, 1];

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetEmbeddingRuntime.mockResolvedValue({ agentRuntime: {}, embeddingModel: 'embed-model' });
    mockEmbed.mockImplementation(async (text: string) => vectorOf(text));
  });

  it('re-embeds an edited activity narrative', async () => {
    await createCaller().updateActivity({ data: { narrative: 'new narrative' }, id: 'act-1' });

    expect(mockActivityUpdate).toHaveBeenCalledWith('act-1', {
      narrative: 'new narrative',
      narrativeVector: vectorOf('new narrative'),
    });
  });

  it('re-embeds an edited context description', async () => {
    await createCaller().updateContext({ data: { description: 'new context' }, id: 'ctx-1' });

    expect(mockContextUpdate).toHaveBeenCalledWith('ctx-1', {
      description: 'new context',
      descriptionVector: vectorOf('new context'),
    });
  });

  it('re-embeds every edited experience field', async () => {
    await createCaller().updateExperience({
      data: { action: 'act', keyLearning: 'learned', situation: 'sit' },
      id: 'exp-1',
    });

    expect(mockExperienceUpdate).toHaveBeenCalledWith('exp-1', {
      action: 'act',
      actionVector: vectorOf('act'),
      keyLearning: 'learned',
      keyLearningVector: vectorOf('learned'),
      situation: 'sit',
      situationVector: vectorOf('sit'),
    });
  });

  it('re-embeds an edited identity description', async () => {
    await createCaller().updateIdentity({ data: { description: 'new identity' }, id: 'id-1' });

    expect(mockUpdateIdentityEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: expect.objectContaining({
          description: 'new identity',
          descriptionVector: vectorOf('new identity'),
        }),
        identityId: 'id-1',
      }),
    );
  });

  it('re-embeds an edited preference directive', async () => {
    await createCaller().updatePreference({
      data: { conclusionDirectives: 'new directive' },
      id: 'pref-1',
    });

    expect(mockPreferenceUpdate).toHaveBeenCalledWith('pref-1', {
      conclusionDirectives: 'new directive',
      conclusionDirectivesVector: vectorOf('new directive'),
    });
  });

  it('keeps the stored vector when the edited text is empty', async () => {
    await createCaller().updateContext({ data: { description: '  ' }, id: 'ctx-1' });

    expect(mockGetEmbeddingRuntime).not.toHaveBeenCalled();
    expect(mockContextUpdate).toHaveBeenCalledWith('ctx-1', { description: '  ' });
  });

  it('still saves the text when embedding fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockEmbed.mockRejectedValue(new Error('provider down'));

    await createCaller().updatePreference({
      data: { conclusionDirectives: 'new directive' },
      id: 'pref-1',
    });

    expect(mockPreferenceUpdate).toHaveBeenCalledWith('pref-1', {
      conclusionDirectives: 'new directive',
    });
    consoleError.mockRestore();
  });
});

describe('userMemoryRouter persona versions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists the caller persona history projection', async () => {
    const versions = [
      {
        createdAt: new Date('2026-07-20T00:00:00.000Z'),
        id: 'history-1',
        nextVersion: 2,
        previousVersion: 1,
        snapshotPersona: '# Persona',
        snapshotTagline: 'Tagline',
      },
    ];
    mockListPersonaVersions.mockResolvedValue(versions);

    await expect(createCaller().listPersonaVersions()).resolves.toEqual(versions);
    expect(mockListPersonaVersions).toHaveBeenCalledWith();
  });

  it('restores a historical snapshot as a new persona version', async () => {
    mockRestorePersonaVersion.mockResolvedValue({ document: { version: 4 } });

    await expect(createCaller().restorePersonaVersion({ historyId: 'history-1' })).resolves.toEqual(
      { historyId: 'history-1', personaVersion: 4 },
    );
    expect(mockRestorePersonaVersion).toHaveBeenCalledWith('history-1');
  });

  it('maps an unavailable persona version to not found', async () => {
    mockRestorePersonaVersion.mockRejectedValue(new UserPersonaVersionNotFoundError());

    await expect(
      createCaller().restorePersonaVersion({ historyId: 'history-missing' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('maps a missing persona snapshot to a failed precondition', async () => {
    mockRestorePersonaVersion.mockRejectedValue(new UserPersonaVersionSnapshotMissingError());

    await expect(
      createCaller().restorePersonaVersion({ historyId: 'history-incomplete' }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it.each(['listPersonaVersions', 'restorePersonaVersion'] as const)(
    'rejects %s in workspace scope',
    async (procedure) => {
      const caller = createCaller({ workspaceId: 'workspace-1' });
      const operation =
        procedure === 'listPersonaVersions'
          ? caller.listPersonaVersions()
          : caller.restorePersonaVersion({ historyId: 'history-1' });

      await expect(operation).rejects.toMatchObject({ code: 'FORBIDDEN' });
    },
  );
});
