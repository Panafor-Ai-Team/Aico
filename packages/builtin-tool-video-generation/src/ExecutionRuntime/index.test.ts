import { AsyncTaskStatus } from '@lobechat/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ListVideoModelsState } from '../types';
import { VideoGenerationExecutionRuntime, type VideoGenerationRuntimeService } from './index';

const grokParameters = {
  aspectRatio: { default: '16:9', enum: ['16:9', '9:16'] },
  duration: { default: 6, max: 15, min: 1 },
  imageUrls: { default: [], maxCount: 2 },
  prompt: { default: '' },
  resolution: { default: '720p', enum: ['480p', '720p'] },
};

const startFrameParameters = {
  duration: { default: 5, max: 10, min: 1 },
  imageUrl: { default: null },
  prompt: { default: '' },
};

const catalog: ListVideoModelsState = {
  providers: [
    {
      id: 'aico',
      models: [{ id: 'veo-3', parameters: startFrameParameters }],
      name: 'Aico',
    },
    {
      id: 'openrouter',
      models: [
        { id: 'google/veo-3.1', parameters: startFrameParameters },
        { id: 'grok-imagine-video', parameters: grokParameters },
      ],
      name: 'OpenRouter',
    },
  ],
  totalModels: 3,
};

const createService = (overrides: Partial<VideoGenerationRuntimeService> = {}) => {
  const service: VideoGenerationRuntimeService = {
    createGenerationTopic: vi.fn().mockResolvedValue('topic-1'),
    createVideo: vi.fn().mockResolvedValue({
      data: {
        batch: { id: 'batch-1' },
        generations: [{ asyncTaskId: 'task-1', id: 'gen-1' }],
      },
      success: true,
    }),
    getGenerationStatus: vi.fn().mockResolvedValue({
      asyncTaskId: 'task-1',
      error: null,
      generation: {
        asset: {
          thumbnailUrl: 'https://cdn.example.com/cover.webp',
          type: 'video',
          url: 'https://cdn.example.com/video.mp4',
        },
      },
      generationId: 'gen-1',
      status: AsyncTaskStatus.Success,
    }),
    listVideoModels: vi.fn().mockResolvedValue(catalog),
    ...overrides,
  };
  return service;
};

describe('VideoGenerationExecutionRuntime.generateVideo', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('pins the default video model and sends schema defaults like Create → Video', async () => {
    const service = createService();
    const runtime = new VideoGenerationExecutionRuntime(service);

    const result = await runtime.generateVideo({ prompt: '  A dog surfing a wave  ' });

    expect(result.success).toBe(true);
    expect(service.createGenerationTopic).toHaveBeenCalledWith('video', 'A dog surfing a wave');
    expect(service.createVideo).toHaveBeenCalledWith({
      generationTopicId: 'topic-1',
      model: 'grok-imagine-video',
      params: {
        aspectRatio: '16:9',
        duration: 6,
        prompt: 'A dog surfing a wave',
        resolution: '720p',
      },
      provider: 'openrouter',
    });
    expect(result.content).toContain('[Generated video](https://cdn.example.com/video.mp4)');
    expect(result.content).not.toContain('cover.webp');
    expect(result.state).toMatchObject({
      generation: { generationId: 'gen-1', status: AsyncTaskStatus.Success },
      model: 'grok-imagine-video',
      provider: 'openrouter',
    });
  });

  it('lets explicit parameters override schema defaults', async () => {
    const service = createService();
    const runtime = new VideoGenerationExecutionRuntime(service);

    await runtime.generateVideo({
      parameters: { aspectRatio: '9:16', duration: 10 },
      prompt: 'Rain on a window',
    });

    expect(vi.mocked(service.createVideo).mock.calls[0][0].params).toMatchObject({
      aspectRatio: '9:16',
      duration: 10,
    });
  });

  it('fits reference images to a model that takes a reference list', async () => {
    const service = createService();
    const runtime = new VideoGenerationExecutionRuntime(service);

    const result = await runtime.generateVideo({
      imageUrls: ['https://a.png', 'https://b.png', 'https://c.png'],
      prompt: 'These two fighting',
    });

    expect(vi.mocked(service.createVideo).mock.calls[0][0].params.imageUrls).toEqual([
      'https://a.png',
      'https://b.png',
    ]);
    expect(result.content).toContain('does not accept 1 of the reference image(s)');
  });

  it('sends the first reference as the start frame when the model only takes one', async () => {
    const service = createService();
    const runtime = new VideoGenerationExecutionRuntime(service);

    await runtime.generateVideo({
      imageUrls: ['https://a.png', 'https://b.png'],
      model: 'veo-3.1',
      prompt: 'Animate this',
    });

    const payload = vi.mocked(service.createVideo).mock.calls[0][0];
    expect(payload.model).toBe('google/veo-3.1');
    expect(payload.params.imageUrl).toBe('https://a.png');
    expect(payload.params.imageUrls).toBeUndefined();
  });

  it('returns a still-processing result the chat card keeps polling', async () => {
    const service = createService({
      getGenerationStatus: vi.fn().mockResolvedValue({
        asyncTaskId: 'task-1',
        error: null,
        generation: null,
        generationId: 'gen-1',
        status: AsyncTaskStatus.Processing,
      }),
    });
    const runtime = new VideoGenerationExecutionRuntime(service);

    const result = await runtime.generateVideo({ prompt: 'Fireworks', waitTimeoutMs: 1000 });

    expect(result.success).toBe(true);
    expect(result.content).toContain('will appear in the chat automatically');
    expect(result.state).toMatchObject({
      generation: { asyncTaskId: 'task-1', generationId: 'gen-1' },
      waitTimedOut: true,
    });
  });

  it('reports a failed generation without retrying', async () => {
    const service = createService({
      getGenerationStatus: vi.fn().mockResolvedValue({
        asyncTaskId: 'task-1',
        error: { body: { detail: 'Content policy violation' }, name: 'ProviderError' },
        generation: null,
        generationId: 'gen-1',
        status: AsyncTaskStatus.Error,
      }),
    });
    const runtime = new VideoGenerationExecutionRuntime(service);

    const result = await runtime.generateVideo({ prompt: 'Something' });

    expect(result.success).toBe(false);
    expect(result.error).toEqual({
      message: 'Content policy violation',
      type: 'VideoGenerationFailed',
    });
    expect(service.createVideo).toHaveBeenCalledTimes(1);
  });

  it('fails clearly when no video model is enabled', async () => {
    const service = createService({
      listVideoModels: vi.fn().mockResolvedValue({ providers: [], totalModels: 0 }),
    });
    const runtime = new VideoGenerationExecutionRuntime(service);

    const result = await runtime.generateVideo({ prompt: 'A cat' });

    expect(result.success).toBe(false);
    expect(result.error).toMatchObject({ type: 'VideoModelNotFound' });
    expect(service.createVideo).not.toHaveBeenCalled();
  });

  it('rejects an empty prompt', async () => {
    const service = createService();
    const runtime = new VideoGenerationExecutionRuntime(service);

    const result = await runtime.generateVideo({ prompt: '   ' });

    expect(result.success).toBe(false);
    expect(service.createGenerationTopic).not.toHaveBeenCalled();
  });
});

describe('VideoGenerationExecutionRuntime.getVideoModelParameters', () => {
  it('returns the schema and defaults for a vendor-prefixed alias', async () => {
    const runtime = new VideoGenerationExecutionRuntime(createService());

    const result = await runtime.getVideoModelParameters({
      model: 'veo-3.1',
      provider: 'openrouter',
    });

    expect(result.success).toBe(true);
    expect(result.state).toMatchObject({
      defaultValues: { duration: 5, imageUrl: null, prompt: '' },
      model: 'google/veo-3.1',
      provider: 'openrouter',
    });
  });
});
