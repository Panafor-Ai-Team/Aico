import type { ModelParamsSchema, RuntimeImageGenParams } from 'model-bank';
import { extractDefaultValues, ModelProvider } from 'model-bank';
import { gptImage2Schema } from 'model-bank/imageParameters';

import { DEFAULT_IMAGE_CONFIG } from '@/const/settings';

/** Aico: the managed catalog is served under the `openrouter` slot. */
export const DEFAULT_AI_IMAGE_PROVIDER = ModelProvider.OpenRouter;
/** GPT Image 2 at medium quality (the `quality` default in its schema). */
export const DEFAULT_AI_IMAGE_MODEL = 'gpt-image-2';

export interface GenerationConfigState {
  parameters: RuntimeImageGenParams;
  parametersSchema: ModelParamsSchema;

  provider: string;
  model: string;
  imageNum: number;

  isAspectRatioLocked: boolean;
  activeAspectRatio: string | null; // string - virtual ratio; null - native ratio

  /**
   * Object-URL previews for reference images currently being uploaded. Shared
   * across the inline reference cards and the page-level drag-upload zone so
   * both surfaces show the same in-flight loading placeholders.
   */
  uploadingImagePreviews: string[];

  /**
   * Marks whether the configuration has been initialized (including restoration from memory)
   */
  isInit: boolean;
}

export const DEFAULT_IMAGE_GENERATION_PARAMETERS: RuntimeImageGenParams =
  extractDefaultValues(gptImage2Schema);

export const initialGenerationConfigState: GenerationConfigState = {
  model: DEFAULT_AI_IMAGE_MODEL,
  provider: DEFAULT_AI_IMAGE_PROVIDER,
  imageNum: DEFAULT_IMAGE_CONFIG.defaultImageNum,
  parameters: DEFAULT_IMAGE_GENERATION_PARAMETERS,
  parametersSchema: gptImage2Schema,
  isAspectRatioLocked: false,
  activeAspectRatio: null,
  uploadingImagePreviews: [],
  isInit: false,
};
