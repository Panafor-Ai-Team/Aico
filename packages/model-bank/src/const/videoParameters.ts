import type { VideoModelParamsSchema } from '../standard-parameters/video';
import type { Pricing } from '../types/aiModel';

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

/**
 * Default CVC tokens bought by one USD — same figure as
 * `DEFAULT_CVC_TOKENS_PER_USD` in the CheapVibeCode runtime. Generation cards
 * store USD rates derived at this rate; a live `AICO_CVC_TOKENS_PER_USD`
 * override re-denominates chat multipliers, not these baked rates.
 */
export const CHEAPVIBECODE_TOKENS_PER_USD = 25_000_000;

/** USD for a CheapVibeCode token charge at {@link CHEAPVIBECODE_TOKENS_PER_USD}. */
export const cheapVibeCodeTokensToUsd = (tokens: number): number =>
  tokens / CHEAPVIBECODE_TOKENS_PER_USD;

/**
 * CheapVibeCode Grok Imagine Video output pricing (per second) plus the flat
 * image-to-video input fee:
 *
 * - text → video: 480p 250K/sec · 720p 350K/sec
 * - image → video: 480p 400K/sec · 720p 700K/sec
 * - image-to-video input: +50K
 *
 * `source` is `text` or `image` (see `estimateVideoGenerationCostUsd`).
 */
export const cheapVibeCodeGrokImagineVideoPricing: Pricing = {
  units: [
    {
      lookup: {
        prices: {
          '480p_image': cheapVibeCodeTokensToUsd(400_000),
          '480p_text': cheapVibeCodeTokensToUsd(250_000),
          '720p_image': cheapVibeCodeTokensToUsd(700_000),
          '720p_text': cheapVibeCodeTokensToUsd(350_000),
        },
        pricingParams: ['resolution', 'source'],
      },
      name: 'videoGeneration',
      strategy: 'lookup',
      unit: 'second',
    },
    {
      // Flat fee when `source` is image; estimate adds it only for image-to-video.
      name: 'imageInput',
      rate: cheapVibeCodeTokensToUsd(50_000),
      strategy: 'fixed',
      unit: 'image',
    },
  ],
};

/**
 * CheapVibeCode Kling Video V3 (`kling-video-v3`), from CVC's model docs:
 * 3–15 sec, 720p / 1080p / 4K, text or first frame or first/last frame, audio
 * on by default (`enable_audio: false` turns it off). Only `16:9` is documented
 * as an aspect ratio, so it is the only one offered.
 */
export const cheapVibeCodeKlingVideoV3Parameters: VideoModelParamsSchema = {
  aspectRatio: { default: '16:9', enum: ['16:9'] },
  duration: { default: 5, max: 15, min: 3 },
  endImageUrl: { default: null },
  generateAudio: { default: true },
  imageUrl: { default: null },
  prompt: { default: '' },
  resolution: { default: '720p', enum: ['720p', '1080p', '4k'] },
};

/**
 * Kling Video V3 output pricing per second, with and without audio:
 * 720p 470K / 320K · 1080p 630K / 420K · 4K 1.56M / 1.56M. CVC charges
 * rate × selected duration up front and refunds a failed task in full.
 */
export const cheapVibeCodeKlingVideoV3Pricing: Pricing = {
  units: [
    {
      lookup: {
        prices: {
          '1080p_false': cheapVibeCodeTokensToUsd(420_000),
          '1080p_true': cheapVibeCodeTokensToUsd(630_000),
          '4k_false': cheapVibeCodeTokensToUsd(1_560_000),
          '4k_true': cheapVibeCodeTokensToUsd(1_560_000),
          '720p_false': cheapVibeCodeTokensToUsd(320_000),
          '720p_true': cheapVibeCodeTokensToUsd(470_000),
        },
        pricingParams: ['resolution', 'generateAudio'],
      },
      name: 'videoGeneration',
      strategy: 'lookup',
      unit: 'second',
    },
  ],
};

/**
 * CheapVibeCode MiniMax Video H3 (`minimax-video-h3`), from CVC's model docs:
 * 4–15 sec, 768p / 2K, audio always included, first/last frame or up to 4
 * reference images (frames and references cannot be mixed). Only `16:9` is
 * documented as an aspect ratio.
 */
export const cheapVibeCodeMiniMaxVideoH3Parameters: VideoModelParamsSchema = {
  aspectRatio: { default: '16:9', enum: ['16:9'] },
  duration: { default: 5, max: 15, min: 4 },
  endImageUrl: { default: null },
  imageUrl: { default: null },
  imageUrls: { default: [], maxCount: 4 },
  prompt: { default: '' },
  resolution: { default: '768p', enum: ['768p', '2k'] },
};

/** MiniMax Video H3 output pricing per second: 768p 260K · 2K 420K (audio included). */
export const cheapVibeCodeMiniMaxVideoH3Pricing: Pricing = {
  units: [
    {
      lookup: {
        prices: {
          '2k': cheapVibeCodeTokensToUsd(420_000),
          '768p': cheapVibeCodeTokensToUsd(260_000),
        },
        pricingParams: ['resolution'],
      },
      name: 'videoGeneration',
      strategy: 'lookup',
      unit: 'second',
    },
  ],
};
