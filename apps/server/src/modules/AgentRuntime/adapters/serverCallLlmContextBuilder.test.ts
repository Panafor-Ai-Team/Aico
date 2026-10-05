import type { AgentState } from '@lobechat/agent-runtime';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RuntimeExecutorContext } from '../context';
import { buildServerCallLlmContext, containsCredsPlaceholder } from './serverCallLlmContextBuilder';
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

const createTooling = (systemRole?: string): ServerCallLlmTooling =>
  ({
    resolved: {
      enabledToolIds: systemRole ? ['lobe-creds'] : [],
      executorMap: {},
      manifestMap: {},
      promptManifestMap: systemRole
        ? { 'lobe-creds': { api: [], identifier: 'lobe-creds', meta: {}, systemRole } }
        : {},
      sourceMap: {},
      tools: [],
    },
  }) as unknown as ServerCallLlmTooling;

const ctx = {
  agentConfig: { plugins: [], systemRole: 'You are helpful' },
  operationId: 'op-1',
  serverDB: {},
  stepIndex: 0,
  userId: 'user-1',
} as unknown as RuntimeExecutorContext;

const state = { metadata: { agentId: 'agent-1', topicId: 'topic-1' } } as unknown as AgentState;

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

describe('containsCredsPlaceholder', () => {
  it('finds placeholders nested in arrays and objects, tolerating inner whitespace', () => {
    expect(containsCredsPlaceholder({ a: [{ b: 'x {{CREDS_LIST}} y' }] })).toBe(true);
    expect(containsCredsPlaceholder(['{{ COMPOSIO_SERVICES_LIST }}'])).toBe(true);
  });

  it('ignores other placeholders and survives cyclic objects', () => {
    const cyclic: Record<string, unknown> = { text: '{{username}}' };
    cyclic.self = cyclic;

    expect(containsCredsPlaceholder(cyclic)).toBe(false);
    expect(containsCredsPlaceholder(undefined)).toBe(false);
  });
});

describe('buildServerCallLlmContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveHints.mockResolvedValue(createHints());
    mocks.serverMessagesEngine.mockResolvedValue([{ content: 'Hello', role: 'user' }]);
    mocks.getInfoForAIGeneration.mockResolvedValue({
      responseLanguage: 'fa-IR',
      userName: 'Arash',
    });
    mocks.findTopicById.mockResolvedValue({ title: 'Topic' });
    mocks.credsList.mockResolvedValue({
      data: [{ key: 'GITHUB_TOKEN', name: 'GitHub', type: 'kv-env' }],
    });
  });

  it('skips the creds lookup when nothing in the prompt references it', async () => {
    await build(createTooling());

    expect(mocks.credsList).not.toHaveBeenCalled();
    expect(engineVariables().CREDS_LIST).toBe('');
  });

  it('fills CREDS_LIST when the creds tool prompt references it', async () => {
    await build(createTooling('Available creds:\n{{CREDS_LIST}}'));

    expect(mocks.credsList).toHaveBeenCalledTimes(1);
    expect(engineVariables().CREDS_LIST).toContain('GITHUB_TOKEN');
  });

  it('fills CREDS_LIST when the placeholder only arrives through fetched context', async () => {
    mocks.findTopicById.mockResolvedValue({ title: 'Use {{CREDS_LIST}}' });

    await build(createTooling());

    expect(mocks.credsList).toHaveBeenCalledTimes(1);
    expect(engineVariables().CREDS_LIST).toContain('GITHUB_TOKEN');
  });

  it('starts independent lookups without waiting for context hints', async () => {
    let resolveHints!: (value: ReturnType<typeof createHints>) => void;
    mocks.resolveHints.mockReturnValue(
      new Promise((resolve) => {
        resolveHints = resolve;
      }),
    );

    const pending = build(createTooling());
    await Promise.resolve();

    expect(mocks.getInfoForAIGeneration).toHaveBeenCalledTimes(1);
    expect(mocks.findTopicById).toHaveBeenCalledTimes(1);

    resolveHints(createHints());
    await pending;

    expect(engineVariables()).toMatchObject({
      language: 'fa-IR',
      topic_title: 'Topic',
      username: 'Arash',
    });
  });
});
