import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveEffectiveAgentMode, useEffectiveAgentMode } from './useEffectiveAgentMode';

const testState = vi.hoisted(() => ({
  access: {
    canManageAgent: false,
    isAccessLoading: false,
  },
  agent: {
    agencyConfig: undefined as { modelSelectionPolicy?: 'fixed' | 'member' } | undefined,
    agent: undefined as { visibility?: 'private' | 'public'; workspaceId?: string } | undefined,
    enableAgentMode: true,
    model: 'model-1',
    provider: 'provider-1',
  },
  aiInfra: {
    isReady: true,
  },
  chat: {
    topicPin: undefined as { model: string; provider: string } | undefined,
  },
  lastSupportCheck: undefined as { model: string; provider: string } | undefined,
  supportMap: undefined as Record<string, boolean> | undefined,
  supportToolUse: true,
  user: {
    fetchedPreference: undefined as
      | {
          agentModeOverrides?: Record<string, boolean>;
          agentModelOverrides?: Record<string, { model: string; provider: string }>;
        }
      | null
      | undefined,
    isLoading: false,
    useFetchWorkspaceUserPreference: () => ({
      data: testState.user.fetchedPreference,
      isLoading: testState.user.isLoading,
    }),
    workspaceUserPreference: {} as {
      agentModeOverrides?: Record<string, boolean>;
      agentModelOverrides?: Record<string, { model: string; provider: string }>;
    },
  },
}));

vi.mock('@/features/ResourcePermission/useAgentManagementAccess', () => ({
  useAgentManagementAccess: () => testState.access,
}));

vi.mock('@/hooks/useModelSupportToolUse', () => ({
  useModelSupportToolUse: (model: string, provider: string) => {
    testState.lastSupportCheck = { model, provider };
    if (testState.supportMap) return !!testState.supportMap[`${provider}/${model}`];
    return testState.supportToolUse;
  },
}));

vi.mock('@/store/agent', () => ({
  useAgentStore: (selector: (s: typeof testState.agent) => unknown) => selector(testState.agent),
}));

vi.mock('@/store/agent/selectors', () => ({
  agentByIdSelectors: {
    getAgencyConfigById: () => (s: typeof testState.agent) => s.agencyConfig,
    getAgentById: () => (s: typeof testState.agent) => s.agent,
    getAgentEnableModeById: () => (s: typeof testState.agent) => s.enableAgentMode,
    getAgentModelById: () => (s: typeof testState.agent) => s.model,
    getAgentModelProviderById: () => (s: typeof testState.agent) => s.provider,
  },
}));

vi.mock('@/store/chat', () => ({
  useChatStore: (selector: (s: typeof testState.chat) => unknown) => selector(testState.chat),
}));

vi.mock('@/store/chat/slices/topic/selectors', () => ({
  topicSelectors: {
    activeTopicModel: (s: typeof testState.chat) => s.topicPin,
  },
}));

vi.mock('@/store/aiInfra', () => ({
  aiProviderSelectors: {
    isInitAiProviderRuntimeState: (s: typeof testState.aiInfra) => s.isReady,
  },
  useAiInfraStore: (selector: (s: typeof testState.aiInfra) => unknown) =>
    selector(testState.aiInfra),
}));

vi.mock('@/store/user', () => ({
  useUserStore: (selector: (s: typeof testState.user) => unknown) => selector(testState.user),
}));

const enabledListState = vi.hoisted(() => ({ list: [] as any[] }));

vi.mock('@/libs/trpc/client', () => ({
  lambdaClient: {
    aicoBilling: { getManagedProviderStatus: { query: vi.fn() } },
    organization: { getMyAllowedModels: { query: vi.fn() } },
  },
}));

vi.mock('@/services/aiModel', () => ({
  aiModelService: { getAiProviderModelList: vi.fn() },
}));
vi.mock('@/hooks/useEnabledChatModels', async () => {
  const actual = await vi.importActual('@/hooks/useEnabledChatModels');
  return {
    ...actual,
    useEnabledChatModelsState: () => ({
      isDataConfirmed: true,
      isPending: false,
      list: enabledListState.list,
    }),
  };
});

beforeEach(() => {
  testState.access.canManageAgent = false;
  testState.access.isAccessLoading = false;
  testState.agent.agencyConfig = undefined;
  testState.agent.agent = undefined;
  testState.agent.enableAgentMode = true;
  testState.agent.model = 'model-1';
  testState.agent.provider = 'provider-1';
  testState.aiInfra.isReady = true;
  testState.chat.topicPin = undefined;
  testState.lastSupportCheck = undefined;
  testState.supportMap = undefined;
  testState.supportToolUse = true;
  enabledListState.list = [];
  testState.user.fetchedPreference = undefined;
  testState.user.isLoading = false;
  testState.user.workspaceUserPreference = {};
});

describe('resolveEffectiveAgentMode', () => {
  it('uses agent mode when the stored mode is enabled and the model supports tool use', () => {
    expect(resolveEffectiveAgentMode({ enableAgentMode: true, supportToolUse: true })).toEqual({
      canSelectAgentMode: true,
      currentMode: 'agent',
      isAgentModeUnavailable: false,
      isAgentRuntimeMode: true,
      supportToolUse: true,
    });
  });

  it('falls back to chat mode without changing the stored mode when the model lacks tool use', () => {
    expect(resolveEffectiveAgentMode({ enableAgentMode: true, supportToolUse: false })).toEqual({
      canSelectAgentMode: false,
      currentMode: 'chat',
      isAgentModeUnavailable: true,
      isAgentRuntimeMode: false,
      supportToolUse: false,
    });
  });

  it('keeps explicit chat mode even when the model supports tool use', () => {
    expect(resolveEffectiveAgentMode({ enableAgentMode: false, supportToolUse: true })).toEqual({
      canSelectAgentMode: true,
      currentMode: 'chat',
      isAgentModeUnavailable: false,
      isAgentRuntimeMode: false,
      supportToolUse: true,
    });
  });

  describe('when the model list is not ready yet', () => {
    it('honours stored agent mode instead of downgrading on the transient unknown', () => {
      // supportToolUse is `false` only because the model has not hydrated yet.
      // We must NOT flash to chat mode / mark agent mode unavailable.
      expect(
        resolveEffectiveAgentMode({
          enableAgentMode: true,
          isModelListReady: false,
          supportToolUse: false,
        }),
      ).toEqual({
        canSelectAgentMode: true,
        currentMode: 'agent',
        isAgentModeUnavailable: false,
        isAgentRuntimeMode: true,
        supportToolUse: true,
      });
    });

    it('still respects an explicit chat-mode choice while not ready', () => {
      expect(
        resolveEffectiveAgentMode({
          enableAgentMode: false,
          isModelListReady: false,
          supportToolUse: false,
        }),
      ).toEqual({
        canSelectAgentMode: true,
        currentMode: 'chat',
        isAgentModeUnavailable: false,
        isAgentRuntimeMode: false,
        supportToolUse: true,
      });
    });

    it('applies the real capability once the list becomes ready', () => {
      expect(
        resolveEffectiveAgentMode({
          enableAgentMode: true,
          isModelListReady: true,
          supportToolUse: false,
        }),
      ).toEqual({
        canSelectAgentMode: false,
        currentMode: 'chat',
        isAgentModeUnavailable: true,
        isAgentRuntimeMode: false,
        supportToolUse: false,
      });
    });
  });
});

describe('useEffectiveAgentMode', () => {
  it('uses an ordinary member personal mode for a public Workspace Agent', () => {
    testState.agent.agent = { visibility: 'public', workspaceId: 'workspace-1' };
    testState.user.workspaceUserPreference = {
      agentModeOverrides: { 'agent-1': false },
    };

    const { result } = renderHook(() => useEffectiveAgentMode('agent-1'));

    expect(result.current).toMatchObject({
      currentMode: 'chat',
      isAgentRuntimeMode: false,
      isPreferenceLoading: false,
      usesWorkspaceMemberMode: true,
    });
  });

  it('ignores a member override for the author or Workspace admin', () => {
    testState.access.canManageAgent = true;
    testState.agent.agent = { visibility: 'public', workspaceId: 'workspace-1' };
    testState.user.workspaceUserPreference = {
      agentModeOverrides: { 'agent-1': false },
    };

    const { result } = renderHook(() => useEffectiveAgentMode('agent-1'));

    expect(result.current).toMatchObject({
      currentMode: 'agent',
      isAgentRuntimeMode: true,
      isPreferenceLoading: false,
      usesWorkspaceMemberMode: false,
    });
  });

  it('waits for the ordinary member preference before exposing the mode control', () => {
    testState.agent.agent = { visibility: 'public', workspaceId: 'workspace-1' };
    testState.user.isLoading = true;

    const { result } = renderHook(() => useEffectiveAgentMode('agent-1'));

    expect(result.current.isPreferenceLoading).toBe(true);
  });

  it('gates agent mode on the member-overridden model instead of the shared default', () => {
    // Shared default lacks tool calling, but the ordinary member picked a
    // tool-capable model — the switcher must check the effective model, or
    // the member is stranded in chat mode with the agent option disabled.
    testState.agent.agent = { visibility: 'public', workspaceId: 'workspace-1' };
    testState.agent.model = 'chat-only-model';
    testState.agent.provider = 'provider-1';
    testState.user.workspaceUserPreference = {
      agentModelOverrides: { 'agent-1': { model: 'tool-model', provider: 'provider-1' } },
    };
    testState.supportMap = { 'provider-1/tool-model': true };

    const { result } = renderHook(() => useEffectiveAgentMode('agent-1'));

    expect(testState.lastSupportCheck).toEqual({ model: 'tool-model', provider: 'provider-1' });
    expect(result.current).toMatchObject({
      canSelectAgentMode: true,
      currentMode: 'agent',
      isAgentModeUnavailable: false,
    });
  });

  it('gates agent mode on the active topic pin when it overrides the agent model', () => {
    // The trigger shows the topic pin and generation runs it — a tool-less
    // pin must surface chat mode even though the agent default supports tools.
    testState.agent.model = 'tool-model';
    testState.agent.provider = 'provider-1';
    testState.chat.topicPin = { model: 'chat-only-model', provider: 'provider-1' };
    testState.supportMap = { 'provider-1/tool-model': true };

    const { result } = renderHook(() => useEffectiveAgentMode('agent-1'));

    expect(testState.lastSupportCheck).toEqual({
      model: 'chat-only-model',
      provider: 'provider-1',
    });
    expect(result.current).toMatchObject({
      canSelectAgentMode: false,
      currentMode: 'chat',
      isAgentModeUnavailable: true,
    });
  });

  it('prefers the switcher-visible abilities over a stale raw lookup (no refresh needed)', () => {
    // The raw runtime-state snapshot only refreshes on mount/focus while the
    // switcher list carries freshly served abilities: a model the raw table
    // still records as tool-less must unlock the moment it is picked.
    testState.agent.model = 'tool-model';
    testState.agent.provider = 'provider-1';
    testState.supportMap = {};
    enabledListState.list = [
      {
        children: [{ abilities: { functionCall: true }, id: 'tool-model' }],
        id: 'provider-1',
        name: 'P1',
        source: 'builtin',
      },
    ];

    const { result } = renderHook(() => useEffectiveAgentMode('agent-1'));

    expect(result.current).toMatchObject({
      canSelectAgentMode: true,
      currentMode: 'agent',
      isAgentModeUnavailable: false,
    });
  });

  it('falls back to the raw lookup when the model is absent from the visible list', () => {
    // Loading/fail-closed lists must never read as "no tool calling".
    testState.agent.model = 'tool-model';
    testState.agent.provider = 'provider-1';
    testState.supportMap = { 'provider-1/tool-model': true };
    enabledListState.list = [];

    const { result } = renderHook(() => useEffectiveAgentMode('agent-1'));

    expect(result.current).toMatchObject({
      canSelectAgentMode: true,
      currentMode: 'agent',
      isAgentModeUnavailable: false,
    });
  });

  it('keeps the agent option selectable for a tool-capable topic pin on a chat-mode agent', () => {
    // Stored conversation mode + a tool-capable pin: the pill stays chat,
    // but the agent option must not read as unsupported — otherwise the
    // chat→agent switch is impossible from this topic.
    testState.agent.enableAgentMode = false;
    testState.agent.model = 'chat-only-model';
    testState.agent.provider = 'provider-1';
    testState.chat.topicPin = { model: 'tool-model', provider: 'provider-1' };
    testState.supportMap = { 'provider-1/tool-model': true };

    const { result } = renderHook(() => useEffectiveAgentMode('agent-1'));

    expect(testState.lastSupportCheck).toEqual({ model: 'tool-model', provider: 'provider-1' });
    expect(result.current).toMatchObject({
      canSelectAgentMode: true,
      currentMode: 'chat',
      isAgentModeUnavailable: false,
    });
  });
});
