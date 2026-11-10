/**
 * Integration proof for: "when an org admin turns off a model, members
 * currently on that model are switched automatically to an enabled one".
 *
 * Unlike the hook unit tests (every store mocked), this drives the REAL
 * agent / chat / user stores with the REAL `useAgentModelSelection`, so a
 * wiring regression — stale closure, wrong write target, missed effect
 * dependency — fails here. Only the network boundary (services, SWR) and the
 * access gates are mocked; the allow-list itself is steered by swapping the
 * settled enabled list, exactly what the 60s org poll delivers after an
 * admin removal.
 */
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { topicService } from '@/services/topic';
import { workspaceUserSettingsService } from '@/services/workspaceUserSettings';
import { useAgentStore } from '@/store/agent';
import { useAiInfraStore } from '@/store/aiInfra';
import { useChatStore } from '@/store/chat';
import { topicMapKey } from '@/store/chat/utils/topicMapKey';
import { useUserStore } from '@/store/user';
import type { EnabledProviderWithModels } from '@/types/aiProvider';

import { useAutoSwitchUnavailableModel } from './useAutoSwitchUnavailableModel';

vi.mock('@/libs/swr', async () => {
  const actual = await vi.importActual('@/libs/swr');
  return {
    ...actual,
    mutate: vi.fn(),
    useClientDataSWR: () => ({ data: undefined, isLoading: false }),
  };
});

vi.mock('@/libs/trpc/client', () => ({
  lambdaClient: {
    aicoBilling: { getManagedProviderStatus: { query: vi.fn() } },
    organization: { getMyAllowedModels: { query: vi.fn() } },
  },
}));

vi.mock('@/services/aiModel', () => ({
  aiModelService: { getAiProviderModelList: vi.fn() },
}));

vi.mock('@/services/topic', () => ({
  topicService: { updateTopic: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('@/services/workspaceUserSettings', () => ({
  workspaceUserSettingsService: { updatePreference: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('@/features/ChatInput/hooks/useAgentId', () => ({
  useAgentId: () => 'agent-1',
}));

vi.mock('@/features/ResourcePermission/useAgentManagementAccess', () => ({
  // Ordinary member (not author/admin): workspace member-selection mode.
  useAgentManagementAccess: () => ({ canManageAgent: false, isAccessLoading: false }),
}));

vi.mock('@/features/ChatInput/hooks/useChatInputResourceAccess', () => ({
  useChatInputResourceAccess: () => ({
    canConfigureResource: false,
    canUseResource: true,
    isAccessLoading: false,
    isAccessResolved: true,
    isGroupContext: false,
    isResourceGated: true,
  }),
}));

const listState = vi.hoisted(() => ({ list: [] as EnabledProviderWithModels[] }));

vi.mock('@/hooks/useEnabledChatModels', async () => {
  const actual = await vi.importActual('@/hooks/useEnabledChatModels');
  return {
    ...actual,
    useEnabledChatModelsState: () => ({
      isDataConfirmed: true,
      isPending: false,
      list: listState.list,
    }),
  };
});

const REVOKED = { model: 'revoked-model', provider: 'aico' };
const AUTO = { model: 'openrouter/auto', provider: 'aico' };

const orgListWith = (ids: string[]): EnabledProviderWithModels[] => [
  {
    children: ids.map((id) => ({ abilities: {}, id })),
    id: 'aico',
    name: 'Aico',
    source: 'builtin',
  } as EnabledProviderWithModels,
];

const seedAll = (opts: {
  agentDefault?: { model: string; provider: string };
  memberOverride?: { model: string; provider: string } | undefined;
  topicPin?: { model: string; provider: string } | undefined;
}) => {
  useAiInfraStore.setState({ isInitAiProviderRuntimeState: true } as any, false);
  useAgentStore.setState(
    {
      activeAgentId: 'agent-1',
      agentMap: {
        'agent-1': {
          id: 'agent-1',
          model: opts.agentDefault?.model ?? REVOKED.model,
          provider: opts.agentDefault?.provider ?? REVOKED.provider,
          visibility: 'public',
          workspaceId: 'ws-1',
        },
      },
    } as any,
    false,
  );
  useUserStore.setState(
    {
      workspaceUserPreference: {
        agentModelOverrides: {
          'agent-1': opts.memberOverride ?? { ...REVOKED },
        },
      },
    } as any,
    false,
  );
  const key = topicMapKey({ agentId: 'agent-1' });
  useChatStore.setState(
    {
      activeAgentId: 'agent-1',
      activeGroupId: undefined,
      activeTopicId: opts.topicPin ? 'topic-1' : undefined,
      topicDataMap: opts.topicPin
        ? { [key]: { items: [{ id: 'topic-1', ...opts.topicPin }] as any, total: 1 } }
        : {},
    } as any,
    false,
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  listState.list = [];
});

describe('admin disable auto-moves members (integration)', () => {
  it('rewrites the member model override to Auto when the allow-list drops the model', async () => {
    // Settled session parked on the model while it was still allowed.
    listState.list = orgListWith(['openrouter/auto', 'revoked-model', 'kept-model']);
    seedAll({});
    const { rerender } = renderHook(() => useAutoSwitchUnavailableModel());
    expect(workspaceUserSettingsService.updatePreference).not.toHaveBeenCalled();

    // Admin removes the model: the poll delivers a settled list without it.
    listState.list = orgListWith(['openrouter/auto', 'kept-model']);
    await act(async () => {
      rerender();
    });

    expect(workspaceUserSettingsService.updatePreference).toHaveBeenCalledTimes(1);
    expect(workspaceUserSettingsService.updatePreference).toHaveBeenCalledWith({
      agentModelOverrides: { 'agent-1': { ...AUTO } },
    });
    // The member's effective override is Auto now — further renders stay quiet.
    expect(useUserStore.getState().workspaceUserPreference.agentModelOverrides).toEqual({
      'agent-1': { ...AUTO },
    });
    await act(async () => {
      rerender();
    });
    expect(workspaceUserSettingsService.updatePreference).toHaveBeenCalledTimes(1);
  });

  it('re-pins the active topic to Auto while a healthy agent default is untouched', async () => {
    listState.list = orgListWith(['openrouter/auto', 'kept-model']);
    seedAll({
      agentDefault: { model: 'kept-model', provider: 'aico' },
      memberOverride: { model: 'kept-model', provider: 'aico' },
      topicPin: { ...REVOKED },
    });
    renderHook(() => useAutoSwitchUnavailableModel());

    expect(topicService.updateTopic).toHaveBeenCalledTimes(1);
    expect(topicService.updateTopic).toHaveBeenCalledWith('topic-1', { ...AUTO });
    const key = topicMapKey({ agentId: 'agent-1' });
    expect(
      useChatStore.getState().topicDataMap[key]?.items.find((t: any) => t.id === 'topic-1'),
    ).toMatchObject({ ...AUTO });
    // Agent-level selection was never the problem: no override rewrite.
    expect(workspaceUserSettingsService.updatePreference).not.toHaveBeenCalled();
  });

  it('repairs both levels when agent default and topic pin name the revoked model', async () => {
    listState.list = orgListWith(['openrouter/auto', 'kept-model']);
    seedAll({ topicPin: { ...REVOKED } });
    renderHook(() => useAutoSwitchUnavailableModel());

    expect(workspaceUserSettingsService.updatePreference).toHaveBeenCalledTimes(1);
    expect(topicService.updateTopic).toHaveBeenCalledTimes(1);
    expect(topicService.updateTopic).toHaveBeenCalledWith('topic-1', { ...AUTO });
  });
});
