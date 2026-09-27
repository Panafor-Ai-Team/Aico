import type { VideoModelParamsSchema } from '../standard-parameters/video';

/**
 * Grok Imagine Video as served by CheapVibeCode: text to video, image to video
 * from one start frame, and reference to video from several images.
 *
 * CheapVibeCode's documented request takes `duration`, `resolution` and
 * `aspect_ratio`. Its video API mirrors xAI's (`/videos/generations`,
 * `request_id`, `video.url`), so uploads follow xAI's shapes: one image is the
 * `image: { url }` start frame, two or more go out as `reference_images` (xAI
 * caps them at 7 and rejects them combined with `image`). Text-to-video requests
 * stay byte-identical.
 */
export const cheapVibeCodeGrokImagineVideoParameters: VideoModelParamsSchema = {
  aspectRatio: {
    default: '16:9',
    enum: ['16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3'],
  },
  duration: { default: 6, max: 15, min: 1 },
  imageUrls: { default: [], maxCount: 7 },
  prompt: { default: '' },
  resolution: {
    default: '720p',
    enum: ['480p', '720p'],
  },
};
