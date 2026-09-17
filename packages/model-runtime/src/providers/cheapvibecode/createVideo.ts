import createDebug from 'debug';

import type { CreateVideoOptions } from '../../core/openaiCompatibleFactory';
import type {
  CreateVideoPayload,
  CreateVideoResponse,
  PollVideoStatusResult,
} from '../../types/video';

const log = createDebug('lobe-video:cheapvibecode');

/**
 * Video generation is only served by the `ru.` host — `cheapvibecode.ru`
 * answers 404 on every video route — so it cannot reuse the chat `baseURL`.
 */
export const DEFAULT_CVC_VIDEO_BASE_URL = 'https://ru.cheapvibecode.ru/v1';

export const resolveCheapVibeCodeVideoBaseURL = () => {
  const configured = process.env.CHEAPVIBECODE_VIDEO_BASE_URL?.trim().replace(/\/+$/, '');
  if (!configured) return DEFAULT_CVC_VIDEO_BASE_URL;
  return configured.endsWith('/v1') ? configured : `${configured}/v1`;
};

interface CheapVibeCodeVideoTask {
  data?: { request_id?: string };
  error?: { message?: string } | string | null;
  id?: string;
  request_id?: string;
  status?: string;
  video?: { url?: string | null } | null;
}

const FAILED_STATUSES = new Set(['cancelled', 'canceled', 'error', 'expired', 'failed']);

const taskErrorMessage = (error: CheapVibeCodeVideoTask['error']) => {
  if (!error) return 'Video generation failed';
  if (typeof error === 'string') return error;
  return error.message || 'Video generation failed';
};

const authHeaders = (apiKey: string) => ({
  'Authorization': `Bearer ${apiKey}`,
  'Content-Type': 'application/json',
});

const readFailure = async (response: Response) => {
  const detail = (await response.text()).slice(0, 500);
  log('Video API error %s: %s', response.status, detail);
  return new Error(`Video generation failed (${response.status})${detail ? `: ${detail}` : ''}`);
};

const isCheapVibeCodeHost = (url: string) => {
  try {
    const { hostname } = new URL(url);
    return hostname === 'cheapvibecode.ru' || hostname.endsWith('.cheapvibecode.ru');
  } catch {
    return false;
  }
};

export const createCheapVibeCodeVideo = async (
  payload: CreateVideoPayload,
  options: CreateVideoOptions,
): Promise<CreateVideoResponse> => {
  const { model, params } = payload;
  const { aspectRatio, duration, prompt, resolution } = params;

  const body: Record<string, unknown> = { model, prompt };
  if (typeof duration === 'number' && Number.isFinite(duration)) {
    body.duration = Math.round(duration);
  }
  if (resolution) body.resolution = resolution;
  if (aspectRatio) body.aspect_ratio = aspectRatio;

  log('Creating video - model: %s, body: %O', model, body);

  const response = await fetch(`${resolveCheapVibeCodeVideoBaseURL()}/videos/generations`, {
    body: JSON.stringify(body),
    headers: authHeaders(options.apiKey),
    method: 'POST',
  });
  if (!response.ok) throw await readFailure(response);

  const task = (await response.json()) as CheapVibeCodeVideoTask;
  const requestId = task.request_id ?? task.data?.request_id ?? task.id;
  if (!requestId) throw new Error('Invalid response: missing request_id');

  return { inferenceId: requestId };
};

export const pollCheapVibeCodeVideoStatus = async (
  requestId: string,
  options: { apiKey: string },
): Promise<PollVideoStatusResult> => {
  const response = await fetch(
    `${resolveCheapVibeCodeVideoBaseURL()}/videos/${encodeURIComponent(requestId)}`,
    { headers: authHeaders(options.apiKey), method: 'GET' },
  );
  if (!response.ok) throw await readFailure(response);

  const task = (await response.json()) as CheapVibeCodeVideoTask;
  log('Video status: %O', task);

  const videoUrl = task.video?.url;
  if (videoUrl) {
    return {
      // Only hand the key to CheapVibeCode itself, never to a third-party CDN.
      ...(isCheapVibeCodeHost(videoUrl) && {
        headers: { Authorization: `Bearer ${options.apiKey}` },
      }),
      status: 'success',
      videoUrl,
    };
  }

  if (FAILED_STATUSES.has((task.status || '').toLowerCase()) || task.error) {
    return { error: taskErrorMessage(task.error), status: 'failed' };
  }

  return { status: 'pending' };
};
