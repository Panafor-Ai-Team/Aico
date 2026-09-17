// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CreateVideoOptions } from '../../core/openaiCompatibleFactory';
import {
  createCheapVibeCodeVideo,
  DEFAULT_CVC_VIDEO_BASE_URL,
  pollCheapVibeCodeVideoStatus,
} from './createVideo';

vi.mock('debug', () => ({
  default: vi.fn(() => vi.fn()),
}));

const mockOptions: CreateVideoOptions = {
  apiKey: 'test-api-key',
  // The chat host: video must NOT be sent here, it only lives on `ru.`.
  baseURL: 'https://cheapvibecode.ru/v1',
  provider: 'cheapvibecode',
};

const jsonResponse = (body: unknown) => ({ json: async () => body, ok: true });

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.CHEAPVIBECODE_VIDEO_BASE_URL;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createCheapVibeCodeVideo', () => {
  it('posts to the ru host with snake_case fields and returns the request_id', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(jsonResponse({ request_id: 'req-1' }));

    const result = await createCheapVibeCodeVideo(
      {
        model: 'grok-imagine-video',
        params: {
          aspectRatio: '16:9',
          duration: 6.4,
          prompt: 'A cinematic flight over frozen Lake Baikal',
          resolution: '720p',
        },
      },
      mockOptions,
    );

    expect(result).toEqual({ inferenceId: 'req-1' });
    const [url, init] = (global.fetch as any).mock.calls[0];
    expect(url).toBe(`${DEFAULT_CVC_VIDEO_BASE_URL}/videos/generations`);
    expect(JSON.parse(init.body)).toEqual({
      aspect_ratio: '16:9',
      duration: 6,
      model: 'grok-imagine-video',
      prompt: 'A cinematic flight over frozen Lake Baikal',
      resolution: '720p',
    });
    expect(init.headers.Authorization).toBe('Bearer test-api-key');
  });

  it('honours CHEAPVIBECODE_VIDEO_BASE_URL', async () => {
    process.env.CHEAPVIBECODE_VIDEO_BASE_URL = 'https://mirror.cheapvibecode.ru/';
    global.fetch = vi.fn().mockResolvedValueOnce(jsonResponse({ request_id: 'req-2' }));

    await createCheapVibeCodeVideo(
      { model: 'grok-imagine-video', params: { prompt: 'x' } },
      mockOptions,
    );

    expect((global.fetch as any).mock.calls[0][0]).toBe(
      'https://mirror.cheapvibecode.ru/v1/videos/generations',
    );
  });

  it('surfaces an upstream error with its status', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => '{"error":{"message":"The prompt field is required."}}',
    });

    await expect(
      createCheapVibeCodeVideo(
        { model: 'grok-imagine-video', params: { prompt: '' } },
        mockOptions,
      ),
    ).rejects.toThrow('Video generation failed (400)');
  });
});

describe('pollCheapVibeCodeVideoStatus', () => {
  it('is pending until the task carries a video url', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(jsonResponse({ status: 'processing' }));

    await expect(pollCheapVibeCodeVideoStatus('req-1', { apiKey: 'k' })).resolves.toEqual({
      status: 'pending',
    });
    expect((global.fetch as any).mock.calls[0][0]).toBe(
      `${DEFAULT_CVC_VIDEO_BASE_URL}/videos/req-1`,
    );
  });

  it('succeeds once video.url exists, sending the key only to cheapvibecode hosts', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ video: { url: 'https://ru.cheapvibecode.ru/v.mp4' } }))
      .mockResolvedValueOnce(jsonResponse({ video: { url: 'https://cdn.example.com/v.mp4' } }));

    await expect(pollCheapVibeCodeVideoStatus('req-1', { apiKey: 'k' })).resolves.toEqual({
      headers: { Authorization: 'Bearer k' },
      status: 'success',
      videoUrl: 'https://ru.cheapvibecode.ru/v.mp4',
    });
    await expect(pollCheapVibeCodeVideoStatus('req-1', { apiKey: 'k' })).resolves.toEqual({
      status: 'success',
      videoUrl: 'https://cdn.example.com/v.mp4',
    });
  });

  it('fails when the task reports failure', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: { message: 'moderation' }, status: 'failed' }));

    await expect(pollCheapVibeCodeVideoStatus('req-1', { apiKey: 'k' })).resolves.toEqual({
      error: 'moderation',
      status: 'failed',
    });
  });
});
