import type { BuiltinIntervention } from '@lobechat/types';

import { VideoGenerationApiName } from '../../types';
import GenerateVideoIntervention from './GenerateVideo';

/** Only `generateVideo` costs money; the listing / status APIs never ask. */
export const VideoGenerationInterventions: Record<string, BuiltinIntervention> = {
  [VideoGenerationApiName.generateVideo]: GenerateVideoIntervention as BuiltinIntervention,
};

export { default as GenerateVideoIntervention } from './GenerateVideo';
