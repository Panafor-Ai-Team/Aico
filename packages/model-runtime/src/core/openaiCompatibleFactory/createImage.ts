import { imageUrlToBase64 } from '@lobechat/utils';
import { cleanObject } from '@lobechat/utils/object';
import createDebug from 'debug';
import type { RuntimeImageGenParamsValue } from 'model-bank';
import type OpenAI from 'openai';

import type {
  CreateImageMethodOptions,
  CreateImagePayload,
  CreateImageResponse,
} from '../../types/image';
import { getModelPricing } from '../../utils/getModelPricing';
import { parseDataUri } from '../../utils/uriParser';
import { convertImageUrlToFile } from '../contextBuilders/openai';
import { convertOpenAIImageUsage, convertOpenAIUsage } from '../usageConverters/openai';

const log = createDebug('lobe-image:openai-compatible');

/**
 * How reference images are sent when editing an existing image.
 *
 * - `imagesEdit` (default) — multipart `POST /images/edits` with `File` uploads.
 *   OpenAI, Azure, and anything else that implements the OpenAI Images API.
 * - `inputReferences` — JSON `POST /images/generations` carrying an
 *   `input_references` array. Required by OpenRouter, which has **no**
 *   `/images/edits` route at all: calling it returns a bare `404 Not Found`.
 */
export type ImageEditMode = 'imagesEdit' | 'inputReferences';

interface CreateOpenAICompatibleImageOptions {
  imageEditMode?: ImageEditMode;
  pricingContext?: CreateImageMethodOptions['pricingContext'];
  pricingModel?: string;
  requestModel?: string;
  routingModel?: string;
}

/**
 * Generate images using traditional OpenAI images API (DALL-E, etc.)
 */
async function generateByImageMode(
  client: OpenAI,
  payload: CreateImagePayload,
  provider: string,
  imageOptions?: CreateOpenAICompatibleImageOptions,
): Promise<CreateImageResponse> {
  const { model, params } = payload;
  const requestModel = imageOptions?.requestModel ?? model;
  const routingModel = imageOptions?.routingModel ?? model;

  log('Creating image with model: %s and params: %O', requestModel, params);

  // Map parameter names, mapping imageUrls to image
  const paramsMap = new Map<RuntimeImageGenParamsValue, string>([
    ['imageUrls', 'image'],
    ['imageUrl', 'image'],
  ]);
  const userInput: Record<string, any> = Object.fromEntries(
    Object.entries(params).map(([key, value]) => [
      paramsMap.get(key as RuntimeImageGenParamsValue) ?? key,
      value,
    ]),
  );
  // unify image input to array
  if (typeof userInput.image === 'string' && userInput.image.trim() !== '') {
    userInput.image = [userInput.image];
  }

  // https://platform.openai.com/docs/api-reference/images/createEdit
  const isImageEdit = Array.isArray(userInput.image) && userInput.image.length > 0;
  log('isImageEdit: %O, userInput.image: %O', isImageEdit, userInput.image);
  const useInputReferences = imageOptions?.imageEditMode === 'inputReferences';

  if (isImageEdit && useInputReferences) {
    // OpenRouter edits on /images/generations; it has no /images/edits route.
    // Shape mirrors providers/openrouter/createVideo.ts (`imageRef`).
    // Passing URLs straight through also avoids convertImageUrlToFile, i.e. no
    // server-side fetch of the reference — sidestepping the SSRF / private-address
    // problem documented in processImageUrlForChat below.
    userInput.input_references = (userInput.image as string[])
      .filter(Boolean)
      .map((url: string) => ({ image_url: { url }, type: 'image_url' as const }));
    delete userInput.image;
  } else if (isImageEdit) {
    // If there are imageUrls parameters, convert them to File objects
    try {
      // Convert all image URLs to File objects
      const imageFiles = await Promise.all(
        userInput.image.map((url: string) => convertImageUrlToFile(url)),
      );

      // According to official docs, if there are multiple images, pass an array; if only one, pass a single File
      userInput.image = imageFiles.length === 1 ? imageFiles[0] : imageFiles;
    } catch (error) {
      throw new Error(`Failed to convert image URLs to File objects: ${error}`, { cause: error });
    }
  } else {
    delete userInput.image;
  }

  if (userInput.size === 'auto') {
    delete userInput.size;
  }

  // gpt-image-2 dropped input_fidelity ("output is already high fidelity by default").
  // https://developers.openai.com/cookbook/examples/multimodal/image-gen-models-prompting-guide
  // Match the gpt-image-1 family (including dated snapshots like
  // `gpt-image-1-2025-04-15` and the `.5` variant), but exclude the mini tier.
  const isGptImage1Family = /^gpt-image-1(?:$|[-.])/.test(routingModel);
  // `input_fidelity` belongs to the OpenAI /images/edits contract; it has not been
  // probed on the input_references transport, so keep it off there.
  const supportsInputFidelity =
    isImageEdit && !useInputReferences && isGptImage1Family && !routingModel.includes('mini');

  const defaultInput = {
    n: 1,
    ...(routingModel.includes('dall-e') ? { response_format: 'b64_json' } : {}),
    // https://platform.openai.com/docs/api-reference/images/createEdit#images_createedit-input_fidelity
    ...(supportsInputFidelity ? { input_fidelity: 'high' } : {}),
  };

  const options = cleanObject({
    model: requestModel,
    ...defaultInput,
    ...userInput,
  });

  log('options: %O', options);

  // Determine if it's an image editing operation. The input_references transport
  // edits through the generations endpoint, so only the multipart mode calls edit().
  const img =
    isImageEdit && !useInputReferences
      ? await client.images.edit(options as any)
      : await client.images.generate(options as any);

  // Check the integrity of response data
  if (!img || !img.data || !Array.isArray(img.data) || img.data.length === 0) {
    throw new Error('Invalid image response: missing or empty data array');
  }

  const imageData = img.data[0];
  if (!imageData) {
    throw new Error('Invalid image response: first data item is null or undefined');
  }

  let imageUrl: string;

  // Handle base64 format response
  if (imageData.b64_json) {
    // Determine the image's MIME type, default to PNG
    const mimeType = 'image/png'; // OpenAI image generation defaults to PNG format

    // Convert base64 string to complete data URL
    imageUrl = `data:${mimeType};base64,${imageData.b64_json}`;
    log('Successfully converted base64 to data URL, length: %d', imageUrl.length);
  }
  // Handle URL format response
  else if (imageData.url) {
    imageUrl = imageData.url;
    log('Using direct image URL: %s', imageUrl);
  }
  // If neither format exists, throw error
  else {
    throw new Error('Invalid image response: missing both b64_json and url fields');
  }

  return {
    imageUrl,
    ...(img.usage
      ? {
          modelUsage: convertOpenAIImageUsage(
            img.usage,
            await getModelPricing(
              imageOptions?.pricingModel ?? routingModel,
              provider,
              imageOptions?.pricingContext,
            ),
          ),
        }
      : {}),
  };
}

/**
 * Process image URL for chat model input
 */
async function processImageUrlForChat(imageUrl: string): Promise<string> {
  const { type, base64, mimeType } = parseDataUri(imageUrl);

  if (type === 'base64') {
    if (!base64) {
      throw new TypeError("Image URL doesn't contain base64 data");
    }
    return `data:${mimeType || 'image/png'};base64,${base64}`;
  } else if (type === 'url') {
    // Chat hands remote image URLs to the provider untouched and the provider
    // fetches them itself (see contextBuilders/openai.ts's forceImageBase64
    // gate, which OpenRouter never sets). Doing our own server-side fetch here
    // is what breaks Image Create with an uploaded reference: `imageUrlToBase64`
    // goes through ssrfSafeFetch, which rejects an APP_URL or S3 endpoint that
    // resolves to a private/loopback address. Only inline to base64 when an
    // operator has explicitly opted in via the same flag chat already respects.
    if (process.env.LLM_VISION_IMAGE_USE_BASE64 !== '1') return imageUrl;

    const { base64: urlBase64, mimeType: urlMimeType } = await imageUrlToBase64(imageUrl);
    return `data:${urlMimeType};base64,${urlBase64}`;
  } else {
    throw new TypeError(`Currently we don't support image url: ${imageUrl}`);
  }
}

/**
 * OpenRouter (and similar) may return the image in `message.images`, as
 * multimodal `content` parts, or as a data URI / markdown image in a string.
 *
 * Checking only `message.images` is what makes Gemini `:image` edits fail with
 * "No image generated in chat completion response" — it returns one of the
 * other shapes.
 */
export const extractImageUrlFromChatMessage = (message: unknown): string | undefined => {
  if (!message || typeof message !== 'object') return undefined;
  const msg = message as Record<string, unknown>;

  const urlFromImageLike = (value: unknown): string | undefined => {
    if (typeof value === 'string' && value) return value;
    if (!value || typeof value !== 'object') return undefined;
    const rec = value as Record<string, unknown>;
    if (typeof rec.url === 'string' && rec.url) return rec.url;
    if (typeof rec.b64_json === 'string' && rec.b64_json) {
      return `data:image/png;base64,${rec.b64_json}`;
    }
    const nested = rec.image_url ?? rec.imageUrl ?? rec.image;
    if (nested && nested !== value) return urlFromImageLike(nested);
    return undefined;
  };

  const urlFromImagesArray = (images: unknown): string | undefined => {
    if (!Array.isArray(images)) return undefined;
    for (const image of images) {
      const url = urlFromImageLike(image);
      if (url) return url;
    }
    return undefined;
  };

  const fromImages = urlFromImagesArray(msg.images);
  if (fromImages) return fromImages;

  const content = msg.content;
  if (Array.isArray(content)) {
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      const rec = part as Record<string, unknown>;
      const url = urlFromImageLike(rec.image_url ?? rec.imageUrl ?? rec.image ?? rec);
      if (
        url &&
        (rec.type === 'image_url' ||
          rec.type === 'image' ||
          rec.type === 'output_image' ||
          rec.image_url ||
          rec.image ||
          rec.b64_json)
      ) {
        return url;
      }
    }
  }

  if (typeof content === 'string') {
    const dataUri = content.match(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/);
    if (dataUri) return dataUri[0];
    const markdown = content.match(/!\[[^\]]*\]\((data:image\/[^)]+|https?:[^)\s]+)\)/);
    if (markdown?.[1]) return markdown[1];
  }

  return undefined;
};

/**
 * Generate images using chat completion API (OpenRouter Gemini, etc.)
 */
async function generateByChatModel(
  client: OpenAI,
  payload: CreateImagePayload,
  provider: string,
  imageOptions?: CreateOpenAICompatibleImageOptions,
): Promise<CreateImageResponse> {
  const { model, params } = payload;
  const requestModel = imageOptions?.requestModel;
  const actualModel = (requestModel ?? model).replace(':image', ''); // Remove :image suffix

  log('Creating image via chat API with model: %s and params: %O', actualModel, params);

  // Build message content array
  const content: Array<any> = [
    {
      text: params.prompt,
      type: 'text',
    },
  ];

  // Add image(s) for editing mode if provided
  // Support both single imageUrl and multiple imageUrls
  const referenceImages: string[] = [];

  if (params.imageUrl && params.imageUrl !== null) {
    referenceImages.push(params.imageUrl);
  }
  if (Array.isArray(params.imageUrls) && params.imageUrls.length > 0) {
    referenceImages.push(...params.imageUrls);
  }

  // Process all reference images
  for (const imageUrl of referenceImages) {
    log('Processing image URL for editing mode: %s', imageUrl);
    try {
      const processedImageUrl = await processImageUrlForChat(imageUrl);
      content.push({
        image_url: {
          url: processedImageUrl,
        },
        type: 'image_url',
      });
      log('Successfully processed image URL for chat input');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to process image URL (${imageUrl.slice(0, 120)}): ${message}`, {
        cause: error,
      });
    }
  }

  const response = await client.chat.completions.create({
    messages: [
      {
        content,
        role: 'user',
      },
    ],
    model: actualModel,
    // OpenRouter (and similar) require modalities so the model returns an image
    // rather than text. The provider chat() path injects this via handlePayload;
    // createImage uses the raw OpenAI client, so set it here explicitly.
    modalities: ['image', 'text'],
    stream: false,
    // Ask OpenRouter to report real cost in `usage.cost` so the generation
    // cost badge (which reads modelUsage.cost) has something to show. Ignored
    // by OpenAI-compatible endpoints that don't recognize the field.
    usage: { include: true },
  } as Parameters<typeof client.chat.completions.create>[0]);

  log('Chat API response: %O', response);

  // Extract image from response
  const message = response.choices[0]?.message;
  if (!message) {
    throw new Error('No message in chat completion response');
  }

  // Accept every shape providers actually return, not just `message.images`.
  // NOTE: the usage/pricing block below is unchanged — extraction got wider,
  // billing did not move.
  const extractedImageUrl = extractImageUrlFromChatMessage(message);
  if (extractedImageUrl) {
    log('Successfully extracted image from chat response');
    return {
      imageUrl: extractedImageUrl,
      ...(response.usage
        ? {
            modelUsage: convertOpenAIUsage(response.usage, {
              pricing: await getModelPricing(
                imageOptions?.pricingModel ?? actualModel,
                provider,
                imageOptions?.pricingContext,
              ),
              provider,
            }),
          }
        : {}),
    };
  }

  // If no images found, throw error
  throw new Error('No image generated in chat completion response');
}

/**
 * Create image using OpenAI Compatible API
 */
export async function createOpenAICompatibleImage(
  client: OpenAI,
  payload: CreateImagePayload,
  provider: string,
  options?: CreateOpenAICompatibleImageOptions,
): Promise<CreateImageResponse> {
  const { model } = payload;
  const routingModel = options?.routingModel ?? model;

  // Check if it's a chat model for image generation (via :image suffix)
  if (routingModel.endsWith(':image')) {
    return await generateByChatModel(client, payload, provider, options);
  }

  // Dedicated generators (no `:image` suffix) speak the provider's Images API.

  // Default to traditional images API
  return await generateByImageMode(client, payload, provider, options);
}
