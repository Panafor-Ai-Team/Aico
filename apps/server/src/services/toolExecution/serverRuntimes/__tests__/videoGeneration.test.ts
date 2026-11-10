import { beforeEach, describe, expect, it, vi } from 'vitest';

import { videoGenerationRuntime } from '../videoGeneration';

const callerMocks = vi.hoisted(() => ({
  aiModel: vi.fn(() => ({})),
  aiProvider: vi.fn(() => ({})),
  generation: vi.fn(() => ({})),
  generationTopic: vi.fn(() => ({})),
  video: vi.fn(() => ({})),
}));

const billingMocks = vi.hoisted(() => ({
  getOrCreateUserWallet: vi.fn(),
}));

vi.mock('@/database/models/aicoBilling', () => ({
  AicoBillingModel: vi.fn(() => ({
    getOrCreateUserWallet: billingMocks.getOrCreateUserWallet,
  })),
}));

vi.mock('@/server/routers/lambda/aiModel', () => ({
  aiModelRouter: { createCaller: callerMocks.aiModel },
}));
vi.mock('@/server/routers/lambda/aiProvider', () => ({
  aiProviderRouter: { createCaller: callerMocks.aiProvider },
}));
vi.mock('@/server/routers/lambda/generation', () => ({
  generationRouter: { createCaller: callerMocks.generation },
}));
vi.mock('@/server/routers/lambda/generationTopic', () => ({
  generationTopicRouter: { createCaller: callerMocks.generationTopic },
}));
vi.mock('@/server/routers/lambda/video', () => ({
  videoRouter: { createCaller: callerMocks.video },
}));

const factoryContext = {
  clientIp: '203.0.113.7',
  serverDB: {} as never,
  toolManifestMap: {},
  userId: 'user-1',
  workspaceId: 'workspace-1',
};

describe('videoGenerationRuntime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callerMocks.aiModel.mockReturnValue({});
    callerMocks.aiProvider.mockReturnValue({});
    callerMocks.generation.mockReturnValue({});
    callerMocks.generationTopic.mockReturnValue({});
    callerMocks.video.mockReturnValue({});
    billingMocks.getOrCreateUserWallet.mockResolvedValue({
      preferredBillingSource: 'personal',
      preferredOrganizationId: null,
    });
  });

  it('passes the request and workspace scope to every router caller', async () => {
    await videoGenerationRuntime.factory(factoryContext);

    const callerContext = {
      clientIp: '203.0.113.7',
      userId: 'user-1',
      workspaceId: 'workspace-1',
    };
    expect(callerMocks.aiModel).toHaveBeenCalledWith(callerContext);
    expect(callerMocks.aiProvider).toHaveBeenCalledWith(callerContext);
    expect(callerMocks.generation).toHaveBeenCalledWith(callerContext);
    expect(callerMocks.generationTopic).toHaveBeenCalledWith(callerContext);
    expect(callerMocks.video).toHaveBeenCalledWith(callerContext);
  });

  it('creates a video topic and calls createVideo with wallet billing on managed providers only', async () => {
    const createTopic = vi.fn().mockResolvedValue('topic-1');
    const createVideo = vi.fn().mockResolvedValue({
      data: {
        batch: { id: 'batch-1' },
        generations: [{ asyncTaskId: 'task-1', id: 'generation-1' }],
      },
      success: true,
    });
    const getAiProviderModelList = vi.fn().mockResolvedValue([
      { id: 'hidden-video', type: 'video' },
      { id: 'grok-imagine-video', type: 'video' },
    ]);
    billingMocks.getOrCreateUserWallet.mockResolvedValue({
      preferredBillingSource: 'organization',
      preferredOrganizationId: 'org_9',
    });
    callerMocks.generationTopic.mockReturnValue({ createTopic });
    callerMocks.video.mockReturnValue({ createVideo });
    callerMocks.aiModel.mockReturnValue({ getAiProviderModelList });
    callerMocks.aiProvider.mockReturnValue({
      getAiProviderRuntimeState: vi.fn().mockResolvedValue({
        enabledVideoAiProviders: [
          { id: 'google', name: 'Google' },
          { id: 'openrouter', name: 'OpenRouter' },
        ],
        hiddenBuiltinModels: [{ id: 'hidden-video', providerId: 'openrouter' }],
      }),
    });

    const runtime = await videoGenerationRuntime.factory({
      ...factoryContext,
      agentVisibility: 'public',
    });
    const result = await runtime.generateVideo({
      prompt: 'A dog surfing',
      waitUntilComplete: false,
    });

    expect(result.success).toBe(true);
    expect(getAiProviderModelList).toHaveBeenCalledTimes(1);
    expect(getAiProviderModelList).toHaveBeenCalledWith({
      enabled: true,
      id: 'openrouter',
      type: 'video',
    });
    expect(createTopic).toHaveBeenCalledWith({
      title: 'A dog surfing',
      type: 'video',
      visibility: 'public',
    });
    expect(createVideo).toHaveBeenCalledWith(
      expect.objectContaining({
        aicoBilling: { organizationId: 'org_9', source: 'organization' },
        generationTopicId: 'topic-1',
        model: 'grok-imagine-video',
        provider: 'openrouter',
      }),
    );
  });
});
