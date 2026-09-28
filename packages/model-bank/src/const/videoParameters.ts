import type { VideoModelParamsSchema } from '../standard-parameters/video';

/**
 * Grok Imagine Video as served by CheapVibeCode: text to video, plus image to
 * video from a single start frame.
 *
 * CheapVibeCode's documented request takes `duration`, `resolution` and
 * `aspect_ratio`. Its video API mirrors xAI's (`/videos/generations`,
 * `request_id`, `video.url`), so the start frame is sent as `image: { url }`.
 * xAI's `reference_images` is not accepted: CheapVibeCode answers
 * `400 invalid_json` ("Invalid video generation request.") for it.
 */
/**
 * Aico video generation takes one input image. Keeps the model's own image
 * key (start frame `imageUrl`, else a one-item `imageUrls`) so providers still
 * receive the field they read, and drops the end frame.
 */
export const limitVideoParamsToSingleImage = (
  schema: VideoModelParamsSchema,
): VideoModelParamsSchema => {
  const { endImageUrl: _endImageUrl, imageUrls, ...rest } = schema;
  if (!imageUrls || rest.imageUrl) return rest;
  return { ...rest, imageUrls: { ...imageUrls, maxCount: 1 } };
};

export const cheapVibeCodeGrokImagineVideoParameters: VideoModelParamsSchema = {
  aspectRatio: {
    default: '16:9',
    enum: ['16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3'],
  },
  duration: { default: 6, max: 15, min: 1 },
  imageUrl: { default: null },
  prompt: { default: '' },
  resolution: {
    default: '720p',
    enum: ['480p', '720p'],
  },
};
