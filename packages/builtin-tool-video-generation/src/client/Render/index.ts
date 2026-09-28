import type { BuiltinRender } from '@lobechat/types';

import { VideoGenerationApiName } from '../../types';
import GenerateVideoRender from './GenerateVideo';
import GetVideoGenerationStatusRender from './GetVideoGenerationStatus';

export const VideoGenerationRenders: Record<string, BuiltinRender> = {
  [VideoGenerationApiName.generateVideo]: GenerateVideoRender as BuiltinRender,
  [VideoGenerationApiName.getVideoGenerationStatus]:
    GetVideoGenerationStatusRender as BuiltinRender,
};

export { default as GenerateVideoRender } from './GenerateVideo';
export { default as GetVideoGenerationStatusRender } from './GetVideoGenerationStatus';
