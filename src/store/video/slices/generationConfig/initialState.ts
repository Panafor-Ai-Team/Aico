/* eslint-disable perfectionist/sort-interfaces */
import {
  extractVideoDefaultValues,
  ModelProvider,
  type RuntimeVideoGenParams,
  type VideoModelParamsSchema,
} from 'model-bank';
import { cheapVibeCodeKlingVideoV3Parameters } from 'model-bank/videoParameters';

/**
 * Create → Video default: Kling Video V3 behind the managed (`openrouter`) slot,
 * the same default as the chat video tool. LobeHub's Seedance is not served by
 * the managed gateway, so it could never be the default here.
 */
export const DEFAULT_AI_VIDEO_PROVIDER = ModelProvider.OpenRouter;
export const DEFAULT_AI_VIDEO_MODEL = 'kling-video-v3';

const defaultVideoParams: VideoModelParamsSchema = cheapVibeCodeKlingVideoV3Parameters;

export interface VideoGenerationConfigState {
  parameters: RuntimeVideoGenParams;
  parametersSchema: VideoModelParamsSchema;

  provider: string;
  model: string;

  /**
   * Object-URL previews for reference images currently being uploaded. Shared
   * across the inline reference frames and the page-level drag-upload zone so
   * both surfaces show the same in-flight loading placeholders.
   */
  uploadingImagePreviews: string[];

  /**
   * Marks whether the configuration has been initialized (including restoration from memory)
   */
  isInit: boolean;
}

export const DEFAULT_VIDEO_GENERATION_PARAMETERS: RuntimeVideoGenParams =
  extractVideoDefaultValues(defaultVideoParams);

export const initialGenerationConfigState: VideoGenerationConfigState = {
  model: DEFAULT_AI_VIDEO_MODEL,
  provider: DEFAULT_AI_VIDEO_PROVIDER,
  parameters: DEFAULT_VIDEO_GENERATION_PARAMETERS,
  parametersSchema: defaultVideoParams,
  uploadingImagePreviews: [],
  isInit: false,
};
