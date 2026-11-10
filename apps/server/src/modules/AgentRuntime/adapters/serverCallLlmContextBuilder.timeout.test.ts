import type { AgentState } from '@lobechat/agent-runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RuntimeExecutorContext } from '../context';
import { buildServerCallLlmContext } from './serverCallLlmContextBuilder';
import type { ServerCallLlmTooling } from './serverCallLlmTooling';

const mocks = vi.hoisted(() => ({
  credsList: vi.fn(),
  findTopicById: vi.fn(),
  getInfoForAIGeneration: vi.fn(),
  resolveHints: vi.fn(),
  serverMessagesEngine: vi.fn(),
}));

vi.mock('@/config/composio', () => ({ composioEnv: { COMPOSIO_API_KEY: undefined } }));

vi.mock('@/server/modules/Mecha/ContextEngineering', () => ({
  serverMessagesEngine: mocks.serverMessagesEngine,
}));

vi.mock('./serverCallLlmContextHints', () => ({
  resolveServerCallLlmContextHints: mocks.resolveHints,
}));

vi.mock('@/server/services/market', () => ({
  MarketService: vi.fn().mockImplementation(() => ({
    market: { creds: { list: mocks.credsList } },
  })),
}));

vi.mock('@/database/models/user', () => ({
  UserModel: { getInfoForAIGeneration: mocks.getInfoForAIGeneration },
}));

vi.mock('@/database/models/topic', () => ({
  TopicModel: vi.fn().mockImplementation(() => ({ findById: mocks.findTopicById })),
}));

vi.mock('@/database/models/message', () => ({
  MessageModel: vi.fn().mockImplementation(() => ({ query: vi.fn().mockResolvedValue([]) })),
}));

vi.mock('@/server/services/agentDocuments', () => ({
  AgentDocumentsService: vi.fn().mockImplementation(() => ({
    getAgentContextDocuments: vi.fn().mockResolvedValue([]),
  })),
}));

const createHints = () => ({
  capabilities: {
    isCanUseAudio: () => false,
    isCanUseFC: () => true,
    isCanUseVideo: () => false,
    isCanUseVision: () => false,
  },
  messagesForContext: [{ content: 'Hello', role: 'user' }],
  shouldReplayAssistantReasoning: false,
});

const createTooling = (): ServerCallLlmTooling =>
  ({
    resolved: {
      enabledToolIds: [],
      executorMap: {},
      manifestMap: {},
      promptManifestMap: {},
      sourceMap: {},
      tools: [],
    },
  }) as unknown as ServerCallLlmTooling;

const ctx = {
  agentConfig: { chatConfig: { historyCount: 20 }, plugins: [], systemRole: 'You are helpful' },
  operationId: 'op-1',
  serverDB: {},
  stepIndex: 0,
  userId: 'user-1',
} as unknown as RuntimeExecutorContext;

const state = { metadata: { agentId: 'agent-1' } } as unknown as AgentState;

const build = (tooling: ServerCallLlmTooling) =>
  buildServerCallLlmContext({
    ctx,
    llmPayload: { messages: [{ content: 'Hello', role: 'user' }] } as any,
    model: 'gpt-4',
    provider: 'openai',
    state,
    tooling,
  });

const engineVariables = () =>
  mocks.serverMessagesEngine.mock.calls[0][0].additionalVariables as Record<string, string>;

describe('buildServerCallLlmContext lookup timeouts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveHints.mockResolvedValue(createHints());
    mocks.serverMessagesEngine.mockImplementation(async (input: any) => input.messages);
    mocks.getInfoForAIGeneration.mockResolvedValue({
      responseLanguage: 'fa-IR',
      userName: 'Arash',
    });
    mocks.credsList.mockResolvedValue({ data: [] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fails open when a lookup hangs instead of stalling first-token', async () => {
    // Regression: an unbounded DB read stalled chat for 5+ minutes with a
    // partial response. The build must degrade, not hang.
    vi.useFakeTimers();
    mocks.getInfoForAIGeneration.mockReturnValue(new Promise(() => {}));

    const pending = build(createTooling());
    await vi.advanceTimersByTimeAsync(8_000);
    const result = await pending;

    expect(mocks.serverMessagesEngine).toHaveBeenCalledTimes(1);
    expect(engineVariables()).toMatchObject({ language: '', username: '' });
    expect(result.processedMessages).toEqual([{ content: 'Hello', role: 'user' }]);
  });

  it('fails open when a lookup rejects', async () => {
    mocks.getInfoForAIGeneration.mockRejectedValue(new Error('db down'));

    const result = await build(createTooling());

    expect(mocks.serverMessagesEngine).toHaveBeenCalledTimes(1);
    expect(engineVariables()).toMatchObject({ language: '', username: '' });
    expect(result.processedMessages).toEqual([{ content: 'Hello', role: 'user' }]);
  });
});
