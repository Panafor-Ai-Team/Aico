// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CreateVideoOptions } from '../../core/openaiCompatibleFactory';
import type { CreateVideoPayload } from '../../types/video';
import { createOpenRouterVideo, pollOpenRouterVideoStatus } from './createVideo';

vi.mock('debug', () => ({
  default: vi.fn(() => vi.fn()),
}));

const mockOptions: CreateVideoOptions = {
  apiKey: 'test-api-key',
  baseURL: 'https://openrouter.ai/api/v1',
  provider: 'openrouter',
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createOpenRouterVideo', () => {
  it('submits duration and aspect_ratio without any reference images', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      json: async () => ({ id: 'video-job-1' }),
      ok: true,
    });

    const payload: CreateVideoPayload = {
      model: 'google/veo-3',
      params: {
        aspectRatio: '9:16',
        duration: 5.4,
        prompt: 'A cat walking',
        resolution: '1080p',
      },
    };

    const result = await createOpenRouterVideo(payload, mockOptions);

    expect(result).toEqual({ inferenceId: 'video-job-1' });
    expect(fetch).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/videos',
      expect.objectContaining({ method: 'POST' }),
    );
    const body = JSON.parse((global.fetch as any).mock.calls[0][1].body);
    expect(body).toMatchObject({
      aspect_ratio: '9:16',
      duration: 5,
      generate_audio: false,
      model: 'google/veo-3',
      prompt: 'A cat walking',
      resolution: '1080p',
    });
    expect(body.frame_images).toBeUndefined();
    expect(body.input_references).toBeUndefined();
  });

  it('sends a single start frame via frame_images with frame_type first_frame', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      json: async () => ({ id: 'video-job-1' }),
      ok: true,
    });

    const payload: CreateVideoPayload = {
      model: 'google/veo-3',
      params: {
        imageUrl: 'https://cdn.example/start.png',
        prompt: 'A cat walking',
      },
    };

    await createOpenRouterVideo(payload, mockOptions);

    const body = JSON.parse((global.fetch as any).mock.calls[0][1].body);
    expect(body.frame_images).toEqual([
      {
        frame_type: 'first_frame',
        image_url: { url: 'https://cdn.example/start.png' },
        type: 'image_url',
      },
    ]);
    expect(body.input_references).toBeUndefined();
  });

  it('sends start and end frames via frame_images with the right frame_type each', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      json: async () => ({ id: 'video-job-1' }),
      ok: true,
    });

    const payload: CreateVideoPayload = {
      model: 'google/veo-3',
      params: {
        endImageUrl: 'https://cdn.example/end.png',
        imageUrl: 'https://cdn.example/start.png',
        prompt: 'A cat walking',
      },
    };

    await createOpenRouterVideo(payload, mockOptions);

    const body = JSON.parse((global.fetch as any).mock.calls[0][1].body);
    expect(body.frame_images).toEqual([
      {
        frame_type: 'first_frame',
        image_url: { url: 'https://cdn.example/start.png' },
        type: 'image_url',
      },
      {
        frame_type: 'last_frame',
        image_url: { url: 'https://cdn.example/end.png' },
        type: 'image_url',
      },
    ]);
    expect(body.input_references).toBeUndefined();
  });

  it('sends style-reference imageUrls via input_references as objects', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      json: async () => ({ id: 'video-job-1' }),
      ok: true,
    });

    const payload: CreateVideoPayload = {
      model: 'google/veo-3',
      params: {
        imageUrls: ['https://cdn.example/ref1.png', 'https://cdn.example/ref2.png'],
        prompt: 'A cat walking',
      },
    };

    await createOpenRouterVideo(payload, mockOptions);

    const body = JSON.parse((global.fetch as any).mock.calls[0][1].body);
    expect(body.input_references).toEqual([
      { image_url: { url: 'https://cdn.example/ref1.png' }, type: 'image_url' },
      { image_url: { url: 'https://cdn.example/ref2.png' }, type: 'image_url' },
    ]);
    expect(body.frame_images).toBeUndefined();
  });

  it('throws an error including the status and the provider response body', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 402,
      text: async () => 'OpenRouter payment required',
    });

    await expect(
      createOpenRouterVideo({ model: 'google/veo-3', params: { prompt: 'x' } }, mockOptions),
    ).rejects.toThrow('Video generation failed (402): OpenRouter payment required');
  });

  it('throws a bare status message when the response body is empty', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => '',
    });

    await expect(
      createOpenRouterVideo({ model: 'google/veo-3', params: { prompt: 'x' } }, mockOptions),
    ).rejects.toThrow('Video generation failed (400)');
  });
});

describe('pollOpenRouterVideoStatus', () => {
  it('returns the OpenRouter content proxy URL when completed', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      json: async () => ({
        status: 'completed',
        unsigned_urls: ['https://storage.example.com/out.mp4'],
      }),
      ok: true,
    });

    await expect(
      pollOpenRouterVideoStatus('video-job-1', {
        apiKey: 'test-api-key',
        baseURL: 'https://openrouter.ai/api/v1',
      }),
    ).resolves.toMatchObject({
      headers: { Authorization: 'Bearer test-api-key' },
      status: 'success',
      videoUrl: 'https://openrouter.ai/api/v1/videos/video-job-1/content',
    });
  });

  it('persists OpenRouter usage.cost as costUsd and modelUsage', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      json: async () => ({
        status: 'completed',
        unsigned_urls: ['https://storage.example.com/out.mp4'],
        usage: { cost: 0.042 },
      }),
      ok: true,
    });

    await expect(
      pollOpenRouterVideoStatus('video-job-1', { apiKey: 'test-api-key' }),
    ).resolves.toMatchObject({
      costUsd: 0.042,
      modelUsage: { cost: 0.042 },
      status: 'success',
    });
  });

  it('returns pending while the job is still running', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      json: async () => ({ status: 'processing' }),
      ok: true,
    });

    await expect(
      pollOpenRouterVideoStatus('video-job-1', { apiKey: 'test-api-key' }),
    ).resolves.toEqual({ status: 'pending' });
  });

  it('returns failed for cancelled jobs', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      json: async () => ({ error: 'safety filter', status: 'failed' }),
      ok: true,
    });

    await expect(
      pollOpenRouterVideoStatus('video-job-1', { apiKey: 'test-api-key' }),
    ).resolves.toEqual({ error: 'safety filter', status: 'failed' });
  });

  it('includes the response body in the thrown error when polling fails', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: async () => 'job not found',
    });

    await expect(
      pollOpenRouterVideoStatus('video-job-1', { apiKey: 'test-api-key' }),
    ).rejects.toThrow('Video generation failed (404): job not found');
  });
});
