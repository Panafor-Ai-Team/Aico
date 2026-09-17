import type { VideoModelParamsSchema } from '../standard-parameters/video';

/**
 * Grok Imagine Video as served by CheapVibeCode: text to video only.
 *
 * CheapVibeCode's documented request takes `duration`, `resolution` and
 * `aspect_ratio`. It also supports reference images and image-to-video, but the
 * request fields for those are not documented, so they are left out rather than
 * guessed — an unknown field would fail the whole request.
 */
export const cheapVibeCodeGrokImagineVideoParameters: VideoModelParamsSchema = {
  aspectRatio: {
    default: '16:9',
    enum: ['16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3'],
  },
  duration: { default: 6, max: 15, min: 1 },
  prompt: { default: '' },
  resolution: {
    default: '720p',
    enum: ['480p', '720p'],
  },
};
