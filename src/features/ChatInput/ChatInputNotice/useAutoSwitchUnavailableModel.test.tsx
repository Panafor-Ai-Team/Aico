import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { EnabledProviderWithModels } from '@/types/aiProvider';

import {
  isModelInList,
  pickUnavailableModelFallback,
  useAutoSwitchUnavailableModel,
} from './useAutoSwitchUnavailableModel';

const personalList: EnabledProviderWithModels[] = [
  {
    children: [
      { abilities: {}, id: 'gpt-4o' },
      { abilities: {}, id: 'openrouter/auto' },
    ],
    id: 'openai',
    name: 'OpenAI',
    source: 'builtin',
  },
];
const orgList: EnabledProviderWithModels[] = [
  {
    children: [
      { abilities: {}, id: 'openrouter/auto' },
      { abilities: {}, id: 'glm-5-flash' },
    ],
    id: 'aico',
    name: 'Aico',
    source: 'builtin',
  },
];

const testState = vi.hoisted(() => ({
  agentConfigLoading: false,
  canSelectModel: true,
  isInitRuntime: true,
  isModelListPending: false,
  isPreferenceLoading: false,
  list: [] as EnabledProviderWithModels[],
  model: 'gpt-4o',
  provider: 'openai',
  selectionPolicy: 'member' as 'fixed' | 'member',
  selectModel: vi.fn(),
}));

type StoreSelector<T = unknown, S = Record<PropertyKey, unknown>> = (state: S) => T;

vi.mock('@/features/ChatInput/hooks/useAgentId', () => ({
  useAgentId: () => 'agent-id',
}));

vi.mock('@/features/ChatInput/hooks/useAgentModelSelection', () => ({
  useAgentModelSelection: () => ({
    canSelectModel: testState.canSelectModel,
    isPreferenceLoading: testState.isPreferenceLoading,
    model: testState.model,
    provider: testState.provider,
    selectionPolicy: testState.selectionPolicy,
    selectModel: testState.selectModel,
  }),
}));

vi.mock('@/hooks/useEnabledChatModels', () => ({
  useEnabledChatModelsState: () => ({
    isPending: testState.isModelListPending,
    list: testState.list,
  }),
}));

vi.mock('@/store/agent', () => ({
  useAgentStore: <T,>(selector: StoreSelector<T, { loading: boolean }>) =>
    selector({ loading: testState.agentConfigLoading }),
}));

vi.mock('@/store/agent/selectors', () => ({
  agentByIdSelectors: {
    isAgentConfigLoadingById: () => (s: { loading: boolean }) => s.loading,
  },
}));

vi.mock('@/store/aiInfra', () => ({
  aiProviderSelectors: {
    isInitAiProviderRuntimeState: (s: { ready: boolean }) => s.ready,
  },
  useAiInfraStore: <T,>(selector: StoreSelector<T, { ready: boolean }>) =>
    selector({ ready: testState.isInitRuntime }),
}));

describe('isModelInList / pickUnavailableModelFallback', () => {
  it('finds the current model in its provider', () => {
    expect(isModelInList(personalList, 'gpt-4o', 'openai')).toBe(true);
    expect(isModelInList(orgList, 'gpt-4o', 'aico')).toBe(false);
    expect(isModelInList(orgList, 'gpt-4o', 'openai')).toBe(false);
  });

  it('prefers Auto, else the first listed model', () => {
    expect(pickUnavailableModelFallback(orgList)).toEqual({
      model: 'openrouter/auto',
      provider: 'aico',
    });
    expect(
      pickUnavailableModelFallback([
        { children: [{ abilities: {}, id: 'x-1' }], id: 'p', name: 'P', source: 'builtin' },
      ]),
    ).toEqual({
      model: 'x-1',
      provider: 'p',
    });
    expect(pickUnavailableModelFallback([])).toBeUndefined();
  });
});

describe('useAutoSwitchUnavailableModel', () => {
  beforeEach(() => {
    testState.agentConfigLoading = false;
    testState.canSelectModel = true;
    testState.isInitRuntime = true;
    testState.isModelListPending = false;
    testState.isPreferenceLoading = false;
    testState.list = personalList;
    testState.model = 'gpt-4o';
    testState.provider = 'openai';
    testState.selectionPolicy = 'member';
    testState.selectModel = vi.fn();
  });

  it('does nothing on mount or when the model stays valid', () => {
    const { rerender } = renderHook(() => useAutoSwitchUnavailableModel());
    expect(testState.selectModel).not.toHaveBeenCalled();

    // Revalidation with an identical list -> no switch.
    testState.list = personalList;
    rerender();
    expect(testState.selectModel).not.toHaveBeenCalled();
  });

  it('does nothing on mount with an already-missing model (keeps the warning)', () => {
    testState.model = 'gone-model';
    renderHook(() => useAutoSwitchUnavailableModel());
    expect(testState.selectModel).not.toHaveBeenCalled();
  });

  it('switches to Auto when the wallet change strands the model', () => {
    const { rerender } = renderHook(() => useAutoSwitchUnavailableModel());

    // Personal -> organization: new settled list lacks the model.
    testState.list = orgList;
    rerender();

    expect(testState.selectModel).toHaveBeenCalledTimes(1);
    expect(testState.selectModel).toHaveBeenCalledWith({
      model: 'openrouter/auto',
      provider: 'aico',
    });
  });

  it('switches to fallback when a settled list loses the model without a billing change', () => {
    // Admin revokes/deletes the model mid-session: same list source, settled
    // list drops the current model -> session must auto-switch.
    const { rerender } = renderHook(() => useAutoSwitchUnavailableModel());
    expect(testState.selectModel).not.toHaveBeenCalled();

    testState.list = [
      {
        children: [{ abilities: {}, id: 'openrouter/auto' }],
        id: 'openai',
        name: 'OpenAI',
        source: 'builtin',
      },
    ];
    rerender();

    expect(testState.selectModel).toHaveBeenCalledTimes(1);
    expect(testState.selectModel).toHaveBeenCalledWith({
      model: 'openrouter/auto',
      provider: 'openai',
    });
  });

  it('switches an org-wallet revocation to the org Auto fallback', () => {
    testState.list = orgList;
    testState.model = 'glm-5-flash';
    testState.provider = 'aico';
    const { rerender } = renderHook(() => useAutoSwitchUnavailableModel());
    expect(testState.selectModel).not.toHaveBeenCalled();

    // Team allow-list shrinks: only Auto remains.
    testState.list = [
      {
        children: [{ abilities: {}, id: 'openrouter/auto' }],
        id: 'aico',
        name: 'Aico',
        source: 'builtin',
      },
    ];
    rerender();

    expect(testState.selectModel).toHaveBeenCalledTimes(1);
    expect(testState.selectModel).toHaveBeenCalledWith({
      model: 'openrouter/auto',
      provider: 'aico',
    });
  });

  it('waits for the settled list instead of switching mid-reload', () => {
    const { rerender } = renderHook(() => useAutoSwitchUnavailableModel());

    // Revoke lands while the list reloads: must not switch on the transient.
    testState.isModelListPending = true;
    testState.list = [];
    rerender();
    expect(testState.selectModel).not.toHaveBeenCalled();

    testState.isModelListPending = false;
    testState.list = orgList;
    rerender();
    expect(testState.selectModel).toHaveBeenCalledTimes(1);
  });

  it('fires only once: no second switch after the store moves to the fallback', () => {
    const { rerender } = renderHook(() => useAutoSwitchUnavailableModel());

    testState.list = orgList;
    rerender();
    expect(testState.selectModel).toHaveBeenCalledTimes(1);

    // Store catches up with the switch; further renders stay quiet.
    testState.model = 'openrouter/auto';
    testState.provider = 'aico';
    rerender();
    rerender();
    expect(testState.selectModel).toHaveBeenCalledTimes(1);
  });

  it('never switches a locked selection, even when the model is revoked', () => {
    testState.canSelectModel = false;
    const { rerender } = renderHook(() => useAutoSwitchUnavailableModel());

    testState.list = orgList;
    rerender();
    expect(testState.selectModel).not.toHaveBeenCalled();
  });

  it('does nothing when the revoked list has no fallback (warning stays)', () => {
    const { rerender } = renderHook(() => useAutoSwitchUnavailableModel());

    testState.list = [];
    testState.isModelListPending = false;
    rerender();
    expect(testState.selectModel).not.toHaveBeenCalled();
  });
});
