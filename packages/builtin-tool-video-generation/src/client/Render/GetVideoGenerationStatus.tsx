'use client';

import type { BuiltinRenderProps } from '@lobechat/types';
import { Block } from '@lobehub/ui';
import { memo } from 'react';

import type { GetVideoGenerationStatusParams, GetVideoGenerationStatusState } from '../../types';
import { VideoGenerationResult } from './GenerateVideo';

export const GetVideoGenerationStatusRender = memo<
  BuiltinRenderProps<GetVideoGenerationStatusParams, GetVideoGenerationStatusState>
>(({ args, pluginState }) => {
  const generationId = pluginState?.generationId || args?.generationId;
  const asyncTaskId = pluginState?.asyncTaskId || args?.asyncTaskId;
  if (!generationId || !asyncTaskId) return null;

  return (
    <Block variant={'outlined'} width={'100%'}>
      <VideoGenerationResult
        key={`${generationId}-${asyncTaskId}`}
        task={{
          asset: pluginState?.generation?.asset,
          asyncTaskId,
          error: pluginState?.error,
          generationId,
          status: pluginState?.status,
        }}
      />
    </Block>
  );
});

GetVideoGenerationStatusRender.displayName = 'GetVideoGenerationStatusRender';

export default GetVideoGenerationStatusRender;
