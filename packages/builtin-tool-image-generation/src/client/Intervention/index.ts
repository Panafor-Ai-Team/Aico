import type { BuiltinIntervention } from '@lobechat/types';

import { ImageGenerationApiName } from '../../types';
import GenerateImageIntervention from './GenerateImage';

/**
 * Only `generateImage` is confirmed. Listing models or reading a parameter
 * schema is free and side-effect-free, so those APIs stay on `never`.
 */
export const ImageGenerationInterventions: Record<string, BuiltinIntervention> = {
  [ImageGenerationApiName.generateImage]: GenerateImageIntervention as BuiltinIntervention,
};

export { default as GenerateImageIntervention } from './GenerateImage';
