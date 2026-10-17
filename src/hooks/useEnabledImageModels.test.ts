import { BRANDING_NAME, DEFAULT_PROVIDER } from '@lobechat/business-const';
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const useAiInfraStore = vi.fn();
const useAicoBillingStore = vi.fn();
const useClientDataSWR = vi.fn();
const getAiProviderModelList = vi.fn();

vi.mock('@/store/aiInfra', () => ({
  aiProviderSelectors: {
    enabledImageModelList: (state: { enabledImageModelList: unknown }) =>
      state.enabledImageModelList,
  },
  useAiInfraStore: (selector: (state: unknown) => unknown) => useAiInfraStore(selector),
}));

vi.mock('@/features/AicoBilling/store', () => ({
  useAicoBillingStore: (selector: (state: unknown) => unknown) => useAicoBillingStore(selector),
}));

vi.mock('@/libs/swr', () => ({
  useClientDataSWR: (...args: unknown[]) => useClientDataSWR(...args),
}));

vi.mock('@/libs/trpc/client', () => ({
  lambdaClient: {
    aicoBilling: { getManagedProviderStatus: { query: vi.fn() } },
    organization: { getMyAllowedModels: { query: vi.fn() } },
  },
}));

vi.mock('@/services/aiModel', () => ({
  aiModelService: {
    getAiProviderModelList: (...args: unknown[]) => getAiProviderModelList(...args),
  },
}));

describe('useEnabledImageModels', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    useAicoBillingStore.mockImplementation((selector: (state: unknown) => unknown) =>
      selector({ context: { source: 'personal' } }),
    );
    useAiInfraStore.mockImplementation((selector: (state: unknown) => unknown) =>
      selector({
        enabledImageModelList: [
          {
            children: [{ id: 'openrouter/auto' }],
            id: 'openrouter',
            name: 'OpenRouter',
            source: 'builtin',
          },
          { children: [{ id: 'gemini-image' }], id: 'google', name: 'Google', source: 'builtin' },
        ],
      }),
    );
    useClientDataSWR.mockImplementation(() => ({ data: undefined }));
  });

  it('keeps only managed providers when managed mode is on', async () => {
    useClientDataSWR.mockImplementation((key: unknown) => {
      if (key === 'aico-provider-status') return { data: { managed: true } };
      return { data: undefined };
    });

    const { useEnabledImageModels } = await import('./useEnabledImageModels');
    const { result } = renderHook(() => useEnabledImageModels());

    expect(result.current.list.map((provider) => provider.id)).toEqual(['openrouter']);
  });

  it('does not fetch the org allow-list in personal mode', async () => {
    useClientDataSWR.mockImplementation((key: unknown) => {
      if (key === 'aico-provider-status') return { data: { managed: true } };
      return { data: undefined };
    });

    const { useEnabledImageModels } = await import('./useEnabledImageModels');
    renderHook(() => useEnabledImageModels());

    const allowedCalls = useClientDataSWR.mock.calls.filter(
      ([key]) => Array.isArray(key) && key[0] === 'aico-my-allowed-models',
    );
    expect(allowedCalls).toHaveLength(0);
  });

  it('fires the managed catalog fetch on mount even before the billing context resolves', async () => {
    useAicoBillingStore.mockImplementation((selector: (state: unknown) => unknown) =>
      selector({ context: null }),
    );
    useClientDataSWR.mockImplementation((key: unknown, fetcher?: () => unknown) => {
      if (key === 'aico-provider-status') return { data: { managed: true } };
      if (Array.isArray(key) && key[0] === 'aico-managed-model-catalog') {
        fetcher?.();
        return { data: undefined };
      }
      return { data: undefined };
    });

    const { useEnabledImageModels } = await import('./useEnabledImageModels');
    renderHook(() => useEnabledImageModels());

    const catalogKeys = useClientDataSWR.mock.calls
      .filter(([key]) => Array.isArray(key) && key[0] === 'aico-managed-model-catalog')
      .map(([key]) => key);

    // Shared org-independent key, mirroring the chat model list.
    expect(catalogKeys).toEqual([['aico-managed-model-catalog']]);
    expect(getAiProviderModelList).toHaveBeenCalledTimes(1);
    expect(getAiProviderModelList).toHaveBeenCalledWith(DEFAULT_PROVIDER);
  });

  it('keys the org allow-list by organization while the catalog key stays shared', async () => {
    useAicoBillingStore.mockImplementation((selector: (state: unknown) => unknown) =>
      selector({ context: { organizationId: 'org-1', source: 'organization' } }),
    );
    useClientDataSWR.mockImplementation((key: unknown) => {
      if (key === 'aico-provider-status') return { data: { managed: true } };
      return { data: undefined };
    });

    const { useEnabledImageModels } = await import('./useEnabledImageModels');
    renderHook(() => useEnabledImageModels());

    const keys = useClientDataSWR.mock.calls.map(([key]) => key);
    expect(keys).toContainEqual(['aico-my-allowed-models', 'org-1']);
    const catalogKeys = keys.filter(
      (key) => Array.isArray(key) && key[0] === 'aico-managed-model-catalog',
    );
    expect(catalogKeys).toEqual([['aico-managed-model-catalog']]);
  });

  it('on org wallet shows only team-granted image models and hides the rest', async () => {
    useAicoBillingStore.mockImplementation((selector: (state: unknown) => unknown) =>
      selector({ context: { organizationId: 'org-1', source: 'organization' } }),
    );
    useClientDataSWR.mockImplementation((key: unknown) => {
      if (key === 'aico-provider-status') return { data: { managed: true } };
      if (Array.isArray(key) && key[0] === 'aico-my-allowed-models') {
        return { data: { modelIds: ['gateway/img-allowed'] } };
      }
      if (Array.isArray(key) && key[0] === 'aico-managed-model-catalog') {
        return {
          data: [
            { abilities: {}, displayName: 'Allowed', id: 'gateway/img-allowed', type: 'image' },
            { abilities: {}, displayName: 'Blocked', id: 'gateway/img-blocked', type: 'image' },
            {
              abilities: {},
              displayName: 'Disabled',
              enabled: false,
              id: 'gateway/img-disabled',
              type: 'image',
            },
            { abilities: {}, displayName: 'Chat model', id: 'gateway/chat-model', type: 'chat' },
          ],
        };
      }
      return { data: undefined };
    });

    const { useEnabledImageModels } = await import('./useEnabledImageModels');
    const { result } = renderHook(() => useEnabledImageModels());

    expect(result.current.list).toHaveLength(1);
    expect(result.current.list[0].id).toBe('openrouter');
    expect(result.current.list[0].name).toBe(BRANDING_NAME);
    expect(result.current.list[0].children.map((model) => model.id)).toEqual([
      'gateway/img-allowed',
    ]);
  });
});
