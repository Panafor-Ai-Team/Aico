import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useModelSupportAudio } from '@/hooks/useModelSupportAudio';
import { useModelSupportFiles } from '@/hooks/useModelSupportFiles';
import { useModelSupportToolUse } from '@/hooks/useModelSupportToolUse';
import { useModelSupportVideo } from '@/hooks/useModelSupportVideo';
import { useModelSupportVision } from '@/hooks/useModelSupportVision';
import { useAgentStore } from '@/store/agent';
import { useAiInfraStore } from '@/store/aiInfra';
import { useServerConfigStore } from '@/store/serverConfig';

import { isUploadBlockedByAbility, useMediaUploadAbility } from './useMediaUploadAbility';

vi.mock('@/hooks/useModelSupportAudio');
vi.mock('@/hooks/useModelSupportFiles');
vi.mock('@/hooks/useModelSupportToolUse');
vi.mock('@/hooks/useModelSupportVideo');
vi.mock('@/hooks/useModelSupportVision');

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
vi.mock('@/store/agent', () => ({ useAgentStore: vi.fn() }));
vi.mock('@/store/agent/selectors', () => ({
  agentByIdSelectors: {
    getAgencyConfigById: (_id: string) => (s: { heterogeneousType?: string }) =>
      s.heterogeneousType ? { heterogeneousProvider: { type: s.heterogeneousType } } : undefined,
    getAgentEnableModeById: (_id: string) => (s: { enableMode?: boolean }) => !!s.enableMode,
    isAgentHeterogeneousById: (_id: string) => (s: { heterogeneous?: boolean }) =>
      !!s.heterogeneous,
  },
}));
vi.mock('@/store/aiInfra', () => ({
  aiModelSelectors: {
    getEnabledModelById:
      (id: string, provider: string) =>
      (s: {
        enabledAiModels?: {
          abilities: { audio?: boolean; video?: boolean; vision?: boolean };
          id: string;
          providerId: string;
        }[];
      }) =>
        s.enabledAiModels?.find((model) => model.id === id && model.providerId === provider),
  },
  useAiInfraStore: vi.fn(),
}));
vi.mock('@/store/serverConfig', () => ({
  serverConfigSelectors: {
    enableMultimodalUnderstanding: (s: { enableMultimodalUnderstanding: boolean }) =>
      s.enableMultimodalUnderstanding,
    multimodalUnderstanding: (s: {
      multimodalUnderstanding?: { model: string; provider: string };
    }) => s.multimodalUnderstanding,
  },
  useServerConfigStore: vi.fn(),
}));

const mockedUseModelSupportAudio = vi.mocked(useModelSupportAudio);
const mockedUseModelSupportFiles = vi.mocked(useModelSupportFiles);
const mockedUseModelSupportToolUse = vi.mocked(useModelSupportToolUse);
const mockedUseModelSupportVideo = vi.mocked(useModelSupportVideo);
const mockedUseModelSupportVision = vi.mocked(useModelSupportVision);
const mockedUseAgentStore = vi.mocked(useAgentStore);
const mockedUseAiInfraStore = vi.mocked(useAiInfraStore);
const mockedUseServerConfigStore = vi.mocked(useServerConfigStore);

describe('useMediaUploadAbility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    enabledListState.list = [];
    mockedUseModelSupportAudio.mockReturnValue(false);
    mockedUseModelSupportFiles.mockReturnValue(undefined);
    mockedUseModelSupportVision.mockReturnValue(false);
    mockedUseModelSupportVideo.mockReturnValue(false);
    mockedUseModelSupportToolUse.mockReturnValue(false);
    // Default: no agent-mode bypass (plain chat).
    mockedUseAgentStore.mockImplementation((selector: any) =>
      selector({ enableMode: false, heterogeneous: false } as any),
    );
    mockedUseAiInfraStore.mockImplementation((selector) =>
      selector({ enabledAiModels: [] } as any),
    );
    mockedUseServerConfigStore.mockImplementation((selector) =>
      selector({ enableMultimodalUnderstanding: false, multimodalUnderstanding: undefined } as any),
    );
  });

  it('should allow native image upload without tool use', () => {
    mockedUseModelSupportVision.mockImplementation((id) => id === 'model');

    const { result } = renderHook(() => useMediaUploadAbility('model', 'provider'));

    expect(result.current.canUploadAudio).toBe(false);
    expect(result.current.canUploadImage).toBe(true);
    expect(result.current.canUploadVideo).toBe(false);
  });

  it('should allow fallback media upload only when tool use is supported', () => {
    mockedUseModelSupportToolUse.mockReturnValue(true);
    mockedUseAiInfraStore.mockImplementation((selector) =>
      selector({
        enabledAiModels: [
          {
            abilities: { audio: true, video: true, vision: true },
            id: 'fallback-model',
            providerId: 'fallback-provider',
          },
        ],
      } as any),
    );
    mockedUseServerConfigStore.mockImplementation((selector) =>
      selector({
        enableMultimodalUnderstanding: true,
        multimodalUnderstanding: { model: 'fallback-model', provider: 'fallback-provider' },
      } as any),
    );

    const { result } = renderHook(() => useMediaUploadAbility('model', 'provider'));

    expect(result.current.canUploadAudio).toBe(true);
    expect(result.current.canUploadImage).toBe(true);
    expect(result.current.canUploadVideo).toBe(true);
  });

  it('should allow fallback media upload when fallback model abilities are unknown', () => {
    mockedUseModelSupportToolUse.mockReturnValue(true);
    mockedUseServerConfigStore.mockImplementation((selector) =>
      selector({
        enableMultimodalUnderstanding: true,
        multimodalUnderstanding: { model: 'server-only-model', provider: 'server-only-provider' },
      } as any),
    );

    const { result } = renderHook(() => useMediaUploadAbility('model', 'provider'));

    expect(result.current.canUploadAudio).toBe(true);
    expect(result.current.canUploadImage).toBe(true);
    expect(result.current.canUploadVideo).toBe(true);
  });

  it('should reject fallback media upload when tool use is unsupported', () => {
    mockedUseAiInfraStore.mockImplementation((selector) =>
      selector({
        enabledAiModels: [
          {
            abilities: { audio: true, video: true, vision: true },
            id: 'fallback-model',
            providerId: 'fallback-provider',
          },
        ],
      } as any),
    );
    mockedUseServerConfigStore.mockImplementation((selector) =>
      selector({
        enableMultimodalUnderstanding: true,
        multimodalUnderstanding: { model: 'fallback-model', provider: 'fallback-provider' },
      } as any),
    );

    const { result } = renderHook(() => useMediaUploadAbility('model', 'provider'));

    expect(result.current.canUploadAudio).toBe(false);
    expect(result.current.canUploadImage).toBe(false);
    expect(result.current.canUploadVideo).toBe(false);
  });

  it('should respect fallback model media abilities separately', () => {
    mockedUseModelSupportToolUse.mockReturnValue(true);
    mockedUseAiInfraStore.mockImplementation((selector) =>
      selector({
        enabledAiModels: [
          {
            abilities: { audio: false, video: false, vision: true },
            id: 'fallback-model',
            providerId: 'fallback-provider',
          },
        ],
      } as any),
    );
    mockedUseServerConfigStore.mockImplementation((selector) =>
      selector({
        enableMultimodalUnderstanding: true,
        multimodalUnderstanding: { model: 'fallback-model', provider: 'fallback-provider' },
      } as any),
    );

    const { result } = renderHook(() => useMediaUploadAbility('model', 'provider'));

    expect(result.current.canUploadAudio).toBe(false);
    expect(result.current.canUploadImage).toBe(true);
    expect(result.current.canUploadVideo).toBe(false);
  });

  it('should bypass the media gate in agent mode regardless of model abilities', () => {
    mockedUseAgentStore.mockImplementation((selector: any) =>
      selector({ enableMode: true, heterogeneous: false } as any),
    );

    const { result } = renderHook(() => useMediaUploadAbility('model', 'provider', 'agent-1'));

    expect(result.current.canUploadAudio).toBe(true);
    expect(result.current.canUploadImage).toBe(true);
    expect(result.current.canUploadVideo).toBe(true);
  });

  it('should bypass the media gate for heterogeneous agents', () => {
    mockedUseAgentStore.mockImplementation((selector: any) =>
      selector({ enableMode: false, heterogeneous: true, heterogeneousType: 'claude-code' } as any),
    );

    const { result } = renderHook(() => useMediaUploadAbility('model', 'provider', 'agent-1'));

    expect(result.current.canUploadAudio).toBe(true);
    expect(result.current.canUploadImage).toBe(true);
    expect(result.current.canUploadVideo).toBe(true);
  });

  it('should reject image uploads for Kimi Code agents', () => {
    mockedUseAgentStore.mockImplementation((selector: any) =>
      selector({ enableMode: false, heterogeneous: true, heterogeneousType: 'kimi-code' } as any),
    );

    const { result } = renderHook(() => useMediaUploadAbility('model', 'provider', 'agent-1'));

    expect(result.current.canUploadAudio).toBe(true);
    expect(result.current.canUploadImage).toBe(false);
    expect(result.current.canUploadVideo).toBe(true);
  });

  it('should not bypass the media gate when agent mode is explicitly disabled', () => {
    mockedUseModelSupportAudio.mockReturnValue(false);
    mockedUseAgentStore.mockImplementation((selector: any) =>
      selector({ enableMode: false, heterogeneous: false } as any),
    );

    const { result } = renderHook(() => useMediaUploadAbility('model', 'provider', 'agent-1'));

    expect(result.current.canUploadAudio).toBe(false);
    expect(result.current.canUploadImage).toBe(false);
    expect(result.current.canUploadVideo).toBe(false);
  });

  it('should allow document upload by default when the files ability is unknown', () => {
    mockedUseModelSupportFiles.mockReturnValue(undefined);

    const { result } = renderHook(() => useMediaUploadAbility('model', 'provider'));

    expect(result.current.canUploadDocument).toBe(true);
  });

  it('should block document upload only when the model explicitly declares files: false', () => {
    mockedUseModelSupportFiles.mockReturnValue(false);

    const { result } = renderHook(() => useMediaUploadAbility('model', 'provider'));

    expect(result.current.canUploadDocument).toBe(false);
  });

  it('prefers switcher-visible abilities over a stale raw lookup for image upload', () => {
    // Regression (Panachat Auto): the raw snapshot predates the served
    // `vision` flag while the switcher list already carries it — uploads must
    // not wait for a page refresh.
    mockedUseModelSupportVision.mockReturnValue(false);
    enabledListState.list = [
      {
        children: [{ abilities: { vision: true }, id: 'openrouter/auto' }],
        id: 'cheapvibecode',
        name: 'Panachat',
        source: 'builtin',
      },
    ];

    const { result } = renderHook(() => useMediaUploadAbility('openrouter/auto', 'cheapvibecode'));

    expect(result.current.canUploadImage).toBe(true);
  });

  it('falls back to the raw lookup when the model is absent from the visible list', () => {
    mockedUseModelSupportVision.mockImplementation((id) => id === 'model');
    enabledListState.list = [];

    const { result } = renderHook(() => useMediaUploadAbility('model', 'provider'));

    expect(result.current.canUploadImage).toBe(true);
  });
});

describe('isUploadBlockedByAbility', () => {
  const abilities = {
    canUploadAudio: false,
    canUploadDocument: false,
    canUploadImage: true,
    canUploadVideo: false,
  };

  const fileOfType = (type: string) => new File(['x'], 'name', { type });

  it('checks image/video/audio files against their matching ability', () => {
    expect(isUploadBlockedByAbility(fileOfType('image/png'), abilities)).toBe(false);
    expect(isUploadBlockedByAbility(fileOfType('video/mp4'), abilities)).toBe(true);
    expect(isUploadBlockedByAbility(fileOfType('audio/mpeg'), abilities)).toBe(true);
  });

  it('treats anything else as a document, gated on canUploadDocument', () => {
    expect(isUploadBlockedByAbility(fileOfType('application/pdf'), abilities)).toBe(true);
    expect(
      isUploadBlockedByAbility(fileOfType('application/pdf'), {
        ...abilities,
        canUploadDocument: true,
      }),
    ).toBe(false);
  });
});
