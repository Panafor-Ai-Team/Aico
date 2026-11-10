import type { BuiltinPlaceholder } from '@lobechat/types';

import { ImageGenerationApiName } from '../../types';
import GenerateImagePlaceholder from './GenerateImage';

export const ImageGenerationPlaceholders: Record<string, BuiltinPlaceholder> = {
  [ImageGenerationApiName.generateImage]: GenerateImagePlaceholder as BuiltinPlaceholder,
};

export { GenerateImagePlaceholder };
