import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  isModelInList,
  pickBillingSwitchFallbackModel,
  useAutoSwitchModelOnBillingChange,
} from './useAutoSwitchModelOnBillingChange';

interface TestModel {
  id: string;
}

interface TestProviderWithModels {
  children: TestModel[];
  id: string;
}

const personalList: TestProviderWithModels[] = [
  { children: [{ id: 'gpt-4o' }, { id: 'openrouter/auto' }], id: 'openai' },
];
const orgList: TestProviderWithModels[] = [
  { children: [{ id: 'openrouter/auto' }, { id: 'glm-5-flash' }], id: 'aico' },
];

const testState = vi.hoisted(() => ({
  agentConfigLoading: false,
  billingContext: undefined as { organizationId?: string; source: string } | undefined,
  canSelectModel: true,
  isInitRuntime: true,
  isModelListPending: false,
  isPreferenceLoading: false,
  list: [] as TestProviderWithModels[],
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

vi.mock('@/features/AicoBilling/store', () => ({
  useAicoBillingStore: <T,>(selector: StoreSelector<T, { context: unknown }>) =>
    selector({ context: testState.billingContext }),
}));

vi.mock('@/features/AicoBilling/types', () => ({
  billingContextKey: (ctx: { organizationId?: string; source: string }) =>
    ctx.source === 'personal' ? 'personal' : `organization:${ctx.organizationId}`,
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

describe('isModelInList / pickBillingSwitchFallbackModel', () => {
  it('finds the current model in its provider', () => {
    expect(isModelInList(personalList, 'gpt-4o', 'openai')).toBe(true);
    expect(isModelInList(orgList, 'gpt-4o', 'aico')).toBe(false);
    expect(isModelInList(orgList, 'gpt-4o', 'openai')).toBe(false);
  });

  it('prefers Auto, else the first listed model', () => {
    expect(pickBillingSwitchFallbackModel(orgList)).toEqual({
      model: 'openrouter/auto',
      provider: 'aico',
    });
    expect(pickBillingSwitchFallbackModel([{ children: [{ id: 'x-1' }], id: 'p' }])).toEqual({
      model: 'x-1',
      provider: 'p',
    });
    expect(pickBillingSwitchFallbackModel([])).toBeUndefined();
  });
});

describe('useAutoSwitchModelOnBillingChange', () => {
  beforeEach(() => {
    testState.agentConfigLoading = false;
    testState.billingContext = { source: 'personal' };
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
    const { rerender } = renderHook(() => useAutoSwitchModelOnBillingChange());
    expect(testState.selectModel).not.toHaveBeenCalled();

    // Org list still contains the (re-picked) model -> no switch.
    testState.model = 'glm-5-flash';
    testState.provider = 'aico';
    testState.billingContext = { organizationId: 'org-1', source: 'organization' };
    testState.list = orgList;
    rerender();
    expect(testState.selectModel).not.toHaveBeenCalled();
  });

  it('switches to Auto when the wallet change strands the model', () => {
    const { rerender } = renderHook(() => useAutoSwitchModelOnBillingChange());

    testState.billingContext = { organizationId: 'org-1', source: 'organization' };
    testState.list = orgList;
    rerender();

    expect(testState.selectModel).toHaveBeenCalledTimes(1);
    expect(testState.selectModel).toHaveBeenCalledWith({
      model: 'openrouter/auto',
      provider: 'aico',
    });
  });

  it('waits for the new list instead of switching on the stale one', () => {
    const { rerender } = renderHook(() => useAutoSwitchModelOnBillingChange());

    // Context flips while the org allow-list is still loading: the old
    // personal list is stale, the model check must wait.
    testState.billingContext = { organizationId: 'org-1', source: 'organization' };
    testState.isModelListPending = true;
    rerender();
    expect(testState.selectModel).not.toHaveBeenCalled();

    testState.isModelListPending = false;
    testState.list = orgList;
    rerender();
    expect(testState.selectModel).toHaveBeenCalledTimes(1);
  });

  it('never switches a locked selection', () => {
    testState.canSelectModel = false;
    const { rerender } = renderHook(() => useAutoSwitchModelOnBillingChange());

    testState.billingContext = { organizationId: 'org-1', source: 'organization' };
    testState.list = orgList;
    rerender();
    expect(testState.selectModel).not.toHaveBeenCalled();
  });

  it('does nothing when the context never changes, even with a missing model', () => {
    testState.model = 'gone-model';
    renderHook(() => useAutoSwitchModelOnBillingChange());
    // Deprecations keep the explicit warning; only wallet switches auto-move.
    expect(testState.selectModel).not.toHaveBeenCalled();
  });
});
