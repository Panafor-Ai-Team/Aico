import type { ModelParamsSchema } from '../standard-parameters';
import type { Pricing } from '../types/aiModel';
import { cheapVibeCodeTokensToUsd } from './videoParameters';

const NANO_BANANA_ASPECT_RATIOS = [
  'auto',
  '1:1', // 1024x1024 / 2048x2048 / 4096x4096
  '2:3', // 848x1264 / 1696x2528 / 3392x5056
  '3:2', // 1264x848 / 2528x1696 / 5056x3392
  '3:4', // 896x1200 / 1792x2400 / 3584x4800
  '4:3', // 1200x896 / 2400x1792 / 4800x3584
  '4:5', // 928x1152 / 1856x2304 / 3712x4608
  '5:4', // 1152x928 / 2304x1856 / 4608x3712
  '9:16', // 768x1376 / 1536x2752 / 3072x5504
  '16:9', // 1376x768 / 2752x1536 / 5504x3072
  '21:9', // 1584x672 / 3168x1344 / 6336x2688
];

const NANO_BANANA_2_ASPECT_RATIOS = [...NANO_BANANA_ASPECT_RATIOS, '1:4', '4:1', '1:8', '8:1'];

export const gptImage1Schema: ModelParamsSchema = {
  imageUrls: { default: [], maxCount: 1, maxFileSize: 5 * 1024 * 1024 },
  prompt: { default: '' },
  size: {
    default: 'auto',
    enum: ['auto', '1024x1024', '1536x1024', '1024x1536'],
  },
};

export const gptImage2Schema: ModelParamsSchema = {
  imageUrls: { default: [], maxCount: 1, maxFileSize: 5 * 1024 * 1024 },
  prompt: { default: '' },
  quality: { default: 'medium', enum: ['low', 'medium', 'high', 'auto'] },
  size: {
    default: 'auto',
    enum: [
      'auto',
      '1024x1024',
      '1536x1024',
      '1024x1536',
      '2048x2048',
      '2048x1152',
      '3840x2160',
      '2160x3840',
    ],
  },
};

export const nanoBananaParameters: ModelParamsSchema = {
  aspectRatio: {
    default: 'auto',
    enum: NANO_BANANA_ASPECT_RATIOS,
  },
  imageUrls: {
    default: [],
  },
  prompt: { default: '' },
};

export const nanoBananaProParameters: ModelParamsSchema = {
  aspectRatio: {
    default: 'auto',
    enum: NANO_BANANA_ASPECT_RATIOS,
  },
  imageUrls: {
    default: [],
  },
  prompt: { default: '' },
  resolution: {
    default: '1K',
    enum: ['1K', '2K', '4K'],
  },
};

// Nano Banana 2 Lite has no resolution control (fixed 1K output)
export const nanoBanana2LiteParameters: ModelParamsSchema = {
  aspectRatio: {
    default: 'auto',
    enum: NANO_BANANA_2_ASPECT_RATIOS,
  },
  imageUrls: {
    default: [],
  },
  prompt: { default: '' },
};

export const nanoBanana2Parameters: ModelParamsSchema = {
  aspectRatio: {
    default: 'auto',
    enum: NANO_BANANA_2_ASPECT_RATIOS,
  },
  imageUrls: {
    default: [],
  },
  prompt: { default: '' },
  resolution: {
    default: '1K',
    // Gemini image generation API accepts `"512" | "1K" | "2K" | "4K"`.
    // See https://ai.google.dev/gemini-api/docs/image-generation
    enum: ['512', '1K', '2K', '4K'],
  },
};

export const grokImagineImageParameters: ModelParamsSchema = {
  aspectRatio: {
    default: 'auto',
    enum: [
      'auto',
      '1:1',
      '3:4',
      '4:3',
      '9:16',
      '16:9',
      '2:3',
      '3:2',
      '9:19.5',
      '19.5:9',
      '9:20',
      '20:9',
      '1:2',
      '2:1',
    ],
  },
  imageUrls: { default: [] },
  prompt: { default: '' },
  resolution: {
    default: '1k',
    enum: ['1k', '2k'],
  },
};

/**
 * Prompt-only schema for image models behind CheapVibeCode's OpenAI-shaped
 * `/v1/images/generations` when no size / aspect / quality surface is known.
 */
export const cheapVibeCodePromptOnlyImageParameters: ModelParamsSchema = {
  prompt: { default: '' },
};

/**
 * Nano Banana 2 behind CheapVibeCode. Same aspect / resolution surface as
 * {@link nanoBanana2Parameters}, plus OpenAI-shaped thinking level
 * (`reasoning_effort` on the wire). Aspect and resolution use the same
 * `aspect_ratio` / `resolution` field names CheapVibeCode already accepts on
 * video (and xAI uses for Grok Imagine Image).
 */
export const cheapVibeCodeNanoBanana2Parameters: ModelParamsSchema = {
  ...nanoBanana2Parameters,
  reasoningEffort: {
    default: 'medium',
    enum: ['low', 'medium', 'high'],
  },
};

/**
 * Grok Imagine Image behind CheapVibeCode. Same options as
 * {@link grokImagineImageParameters}; wire fields match xAI / CVC video
 * (`aspect_ratio`, `resolution`).
 */
export const cheapVibeCodeGrokImagineImageParameters: ModelParamsSchema = {
  ...grokImagineImageParameters,
};

/**
 * GPT Image 2 behind CheapVibeCode. Same options as {@link gptImage2Schema}, but
 * reference images are capped at OpenAI's `/images/edits` limit of 16 rather
 * than one.
 */
export const cheapVibeCodeGptImage2Parameters: ModelParamsSchema = {
  ...gptImage2Schema,
  imageUrls: { default: [], maxCount: 16, maxFileSize: 5 * 1024 * 1024 },
};

/**
 * GPT Image 2.5 Sunburst / Flare behind CheapVibeCode. Same Images API surface
 * as {@link cheapVibeCodeGptImage2Parameters} (quality, size through 4K, up to
 * 16 reference images on `/v1/images/edits`). CVC charges a fixed token fee by
 * quality tier, independent of size.
 */
export const cheapVibeCodeGptImage25Parameters: ModelParamsSchema = {
  ...cheapVibeCodeGptImage2Parameters,
};

/**
 * Fixed per-image CheapVibeCode token charge for Nano Banana 2: a single
 * 100K tier regardless of resolution. Converted at {@link cheapVibeCodeTokensToUsd}.
 */
export const cheapVibeCodeNanoBanana2Pricing: Pricing = {
  approximatePricePerImage: cheapVibeCodeTokensToUsd(100_000),
  units: [
    {
      name: 'imageGeneration',
      rate: cheapVibeCodeTokensToUsd(100_000),
      strategy: 'fixed',
      unit: 'image',
    },
  ],
};

/**
 * Fixed per-image CheapVibeCode token charge for Grok Imagine Image by
 * quality tier: low 100K · medium 250K · high 350K. `auto` quality is billed
 * as medium. The schema exposes no quality control, so exact costing falls
 * back to the medium approximate until one exists.
 */
export const cheapVibeCodeGrokImagineImagePricing: Pricing = {
  approximatePricePerImage: cheapVibeCodeTokensToUsd(250_000),
  units: [
    {
      lookup: {
        prices: {
          auto: cheapVibeCodeTokensToUsd(250_000),
          high: cheapVibeCodeTokensToUsd(350_000),
          low: cheapVibeCodeTokensToUsd(100_000),
          medium: cheapVibeCodeTokensToUsd(250_000),
        },
        pricingParams: ['quality'],
      },
      name: 'imageGeneration',
      strategy: 'lookup',
      unit: 'image',
    },
  ],
};

/**
 * Fixed per-image CheapVibeCode token charge for GPT Image 2.5 Sunburst / Flare:
 * low 50K · medium 100K · high 150K. `auto` quality is billed as medium until
 * CVC documents otherwise. Converted at {@link cheapVibeCodeTokensToUsd}.
 */
export const cheapVibeCodeGptImage25Pricing: Pricing = {
  approximatePricePerImage: cheapVibeCodeTokensToUsd(100_000),
  units: [
    {
      lookup: {
        prices: {
          auto: cheapVibeCodeTokensToUsd(100_000),
          high: cheapVibeCodeTokensToUsd(150_000),
          low: cheapVibeCodeTokensToUsd(50_000),
          medium: cheapVibeCodeTokensToUsd(100_000),
        },
        pricingParams: ['quality'],
      },
      name: 'imageGeneration',
      strategy: 'lookup',
      unit: 'image',
    },
  ],
};
