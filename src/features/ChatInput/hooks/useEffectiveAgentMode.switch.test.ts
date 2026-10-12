/**
 * Repro for: "Agent mode requires a page refresh to become available after a
 * model switch (chat-only model -> Panachat Auto stays locked until refresh)".
 *
 * Uses the REAL agent / chat / aiInfra stores + REAL selectors (only network
 * services and access hooks are mocked) and drives the REAL switch actions,
 * so a stale gate fails here exactly like it does in the product.
 */
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { agentService } from '@/services/agent';
import { useAgentStore } from '@/store/agent';
import { useAiInfraStore } from '@/store/aiInfra';
import { useChatStore } from '@/store/chat';
import { topicMapKey } from '@/store/chat/utils/topicMapKey';

import { useEffectiveAgentMode } from './useEffectiveAgentMode';

vi.mock('@/libs/swr', async () => {
  const actual = await vi.importActual('@/libs/swr');
  return { ...actual, mutate: vi.fn() };
});

vi.mock('@/services/agent', () => ({
  agentService: { updateAgentConfig: vi.fn() },
}));

vi.mock('@/services/topic', () => ({
  topicService: {
    getTopicDetail: vi.fn(),
    getTopics: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    queryTopics: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    updateTopic: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@/features/ResourcePermission/useAgentManagementAccess', () => ({
  useAgentManagementAccess: () => ({ canManageAgent: true, isAccessLoading: false }),
}));

vi.mock('@/store/user', () => ({
  useUserStore: (selector: (s: any) => unknown) =>
    selector({
      useFetchWorkspaceUserPreference: () => ({ data: undefined, isLoading: false }),
      workspaceUserPreference: {},
    }),
}));

vi.mock('@/libs/trpc/client', () => ({
  lambdaClient: {
    aicoBilling: { getManagedProviderStatus: { query: vi.fn() } },
    organization: { getMyAllowedModels: { query: vi.fn() } },
  },
}));

vi.mock('@/services/aiModel', () => ({
  aiModelService: { getAiProviderModelList: vi.fn() },
}));

const chatListState = vi.hoisted(() => ({ list: [] as any[] }));
vi.mock('@/hooks/useEnabledChatModels', async () => {
  const actual = await vi.importActual('@/hooks/useEnabledChatModels');
  return {
    ...actual,
    useEnabledChatModelsState: () => ({
      isDataConfirmed: true,
      isPending: false,
      list: chatListState.list,
    }),
  };
});

const PROVIDER = 'cheapvibecode';
const CHAT_ONLY = 'chat-only-model';
const AUTO = 'openrouter/auto';

const seedInfra = () => {
  useAiInfraStore.setState(
    {
      aiProviderModelList: [],
      builtinAiModelList: [],
      enabledAiModels: [
        { abilities: {}, id: CHAT_ONLY, providerId: PROVIDER, type: 'chat' },
        { abilities: { functionCall: true }, id: AUTO, providerId: PROVIDER, type: 'chat' },
      ],
      isInitAiProviderRuntimeState: true,
    } as any,
    false,
  );
};

const seedAgent = (model: string, provider: string) => {
  useAgentStore.setState(
    {
      activeAgentId: 'agent-1',
      agentMap: {
        'agent-1': {
          chatConfig: { enableAgentMode: true },
          id: 'agent-1',
          model,
          provider,
        },
      },
    } as any,
    false,
  );
};

const seedChatWithoutTopic = () => {
  useChatStore.setState(
    {
      activeAgentId: 'agent-1',
      activeGroupId: undefined,
      activeTopicId: undefined,
      topicDataMap: {},
    } as any,
    false,
  );
};

const seedChatWithTopic = (model: string, provider: string) => {
  const key = topicMapKey({ agentId: 'agent-1' });
  useChatStore.setState(
    {
      activeAgentId: 'agent-1',
      activeGroupId: undefined,
      activeTopicId: 'topic-1',
      topicDataMap: {
        [key]: { items: [{ id: 'topic-1', model, provider }] as any, total: 1 },
      },
    } as any,
    false,
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  chatListState.list = [];
  seedInfra();
});

describe('model switch unlocks agent mode without refresh', () => {
  it('agent-default switch chat-only -> Auto unlocks immediately (no active topic)', async () => {
    seedAgent(CHAT_ONLY, PROVIDER);
    seedChatWithoutTopic();
    vi.mocked(agentService.updateAgentConfig).mockResolvedValue({
      agent: { id: 'agent-1', model: AUTO, provider: PROVIDER } as any,
      success: true,
    });

    const { result } = renderHook(() => useEffectiveAgentMode('agent-1'));

    expect(result.current).toMatchObject({
      canSelectAgentMode: false,
      currentMode: 'chat',
      isAgentModeUnavailable: true,
    });

    await act(async () => {
      await useAgentStore
        .getState()
        .updateAgentConfigById('agent-1', { model: AUTO, provider: PROVIDER });
    });

    expect(result.current).toMatchObject({
      canSelectAgentMode: true,
      currentMode: 'agent',
      isAgentModeUnavailable: false,
    });
  });

  it('topic-pin switch chat-only -> Auto unlocks immediately (active topic)', async () => {
    seedAgent(CHAT_ONLY, PROVIDER);
    seedChatWithTopic(CHAT_ONLY, PROVIDER);

    const { result } = renderHook(() => useEffectiveAgentMode('agent-1'));

    expect(result.current).toMatchObject({
      canSelectAgentMode: false,
      currentMode: 'chat',
      isAgentModeUnavailable: true,
    });

    await act(async () => {
      await useChatStore
        .getState()
        .updateTopicModel('topic-1', { model: AUTO, provider: PROVIDER });
    });

    expect(result.current).toMatchObject({
      canSelectAgentMode: true,
      currentMode: 'agent',
      isAgentModeUnavailable: false,
    });
  });

  it('switch unlocks from the switcher-visible list even while the raw snapshot is stale', async () => {
    // Raw runtime-state snapshot predates Auto's tool capability (it refreshes
    // on mount/focus only); the switcher list already serves it. The gate must
    // follow the list — the user must not need a page refresh.
    useAiInfraStore.setState(
      {
        enabledAiModels: [
          { abilities: {}, id: CHAT_ONLY, providerId: PROVIDER, type: 'chat' },
          { abilities: {}, id: AUTO, providerId: PROVIDER, type: 'chat' },
        ],
      } as any,
      false,
    );
    chatListState.list = [
      {
        children: [
          { abilities: {}, id: CHAT_ONLY },
          { abilities: { functionCall: true }, id: AUTO },
        ],
        id: PROVIDER,
        name: 'Panachat',
        source: 'builtin',
      },
    ];
    seedAgent(CHAT_ONLY, PROVIDER);
    seedChatWithoutTopic();
    vi.mocked(agentService.updateAgentConfig).mockResolvedValue({
      agent: { id: 'agent-1', model: AUTO, provider: PROVIDER } as any,
      success: true,
    });

    const { result } = renderHook(() => useEffectiveAgentMode('agent-1'));

    expect(result.current.canSelectAgentMode).toBe(false);

    await act(async () => {
      await useAgentStore
        .getState()
        .updateAgentConfigById('agent-1', { model: AUTO, provider: PROVIDER });
    });

    expect(result.current).toMatchObject({
      canSelectAgentMode: true,
      currentMode: 'agent',
      isAgentModeUnavailable: false,
    });
  });
});
