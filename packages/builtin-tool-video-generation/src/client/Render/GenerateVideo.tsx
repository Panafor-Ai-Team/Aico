'use client';

import type { BuiltinRenderProps } from '@lobechat/types';
import { Alert, Block, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { GenerationCostBadge } from '@/components/GenerationCostBadge';
import { GenerationElapsedTime } from '@/components/GenerationElapsedTime';
import NeuralNetworkLoading from '@/components/NeuralNetworkLoading';
import { useClientDataSWR } from '@/libs/swr';
import { videoKeys } from '@/libs/swr/keys';
import { normalizeAsyncError } from '@/libs/swr/normalizeError';
import { generationService } from '@/services/generation';

import type {
  GeneratedVideoTask,
  GenerateVideoParams,
  GenerateVideoState,
  GetVideoGenerationStatusState,
} from '../../types';
import { getVideoAssetUrl, getVideoPosterUrl } from '../../videoAsset';

const POLLING_INTERVAL = 5000;

export const styles = createStaticStyles(({ css, cssVar }) => ({
  body: css`
    position: relative;

    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;

    margin: 12px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 8px;

    background: ${cssVar.colorFillTertiary};
  `,
  header: css`
    display: flex;
    gap: 8px;
    align-items: center;
    justify-content: space-between;

    min-width: 0;
    padding-block: 8px;
    padding-inline: 12px;
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};
  `,
  meta: css`
    overflow: hidden;
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 2px;

    min-width: 0;
  `,
  model: css`
    overflow: hidden;

    font-family: ${cssVar.fontFamilyCode};
    font-size: 12px;
    color: ${cssVar.colorTextTertiary};
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  placeholder: css`
    display: flex;
    flex-direction: column;
    gap: 8px;
    align-items: center;
    justify-content: center;

    aspect-ratio: 16 / 9;
    width: 100%;
    max-width: 360px;
    padding: 12px;

    text-align: center;
  `,
  prompt: css`
    overflow: hidden;

    font-size: 13px;
    font-weight: 500;
    color: ${cssVar.colorText};
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  status: css`
    flex-shrink: 0;

    padding-block: 2px;
    padding-inline: 8px;
    border-radius: 999px;

    font-size: 12px;
    color: ${cssVar.colorTextSecondary};

    background: ${cssVar.colorFillTertiary};
  `,
  video: css`
    display: block;
    max-width: 100%;
    max-height: 50vh;
  `,
}));

const isTerminalStatus = (status?: string) => status === 'success' || status === 'error';

const isRunningStatus = (status?: string) => status === 'pending' || status === 'processing';

const errorDetailOf = (error?: GeneratedVideoTask['error']) => {
  if (!error) return;
  const body = error.body;
  if (typeof body === 'string') return body;
  return body.detail;
};

const useVideoGenerationStatus = (task: GeneratedVideoTask, enabled: boolean) => {
  const [pollingStopped, setPollingStopped] = useState(false);

  useEffect(() => {
    setPollingStopped(false);
  }, [task.asyncTaskId, task.generationId]);

  const result = useClientDataSWR<GetVideoGenerationStatusState>(
    enabled && task.asyncTaskId
      ? videoKeys.generationStatus(task.generationId, task.asyncTaskId)
      : null,
    async () => {
      const status = await generationService.getGenerationStatus(
        task.generationId,
        task.asyncTaskId,
      );
      return { ...status, asyncTaskId: task.asyncTaskId, generationId: task.generationId };
    },
    {
      onError: () => setPollingStopped(true),
      onSuccess: () => setPollingStopped(false),
      refreshInterval: (data?: GetVideoGenerationStatusState) =>
        pollingStopped || isTerminalStatus(data?.status) ? 0 : POLLING_INTERVAL,
      shouldRetryOnError: false,
    },
  );

  const { mutate } = result;
  const retry = useCallback(() => {
    setPollingStopped(false);
    void mutate();
  }, [mutate]);

  return { ...result, retry };
};

/**
 * Plays the finished video, or keeps polling while it renders — the tool call
 * may return before the provider finishes, so the card finishes the wait.
 */
export const VideoGenerationResult = memo<{ task: GeneratedVideoTask }>(({ task }) => {
  const { t } = useTranslation('plugin');
  const { data, error, isLoading, isValidating, retry } = useVideoGenerationStatus(
    task,
    !isTerminalStatus(task.status),
  );

  const asset = data?.generation?.asset ?? task.asset;
  const status =
    (error ? 'error' : undefined) ||
    data?.status ||
    task.status ||
    (isLoading ? 'processing' : 'pending');
  const url = getVideoAssetUrl(asset);
  const errorDetail =
    error instanceof Error ? error.message : errorDetailOf(data?.error ?? task.error);
  const canRetry = Boolean(error) && normalizeAsyncError(error).retryable;

  return (
    <div className={styles.body}>
      {url ? (
        <video
          controls
          loop
          playsInline
          className={styles.video}
          poster={getVideoPosterUrl(asset)}
          src={url}
        />
      ) : isRunningStatus(status) ? (
        <div className={styles.placeholder}>
          <NeuralNetworkLoading size={48} />
          <GenerationElapsedTime isActive timerKey={task.generationId} />
        </div>
      ) : (
        <div className={styles.placeholder}>
          <Text
            as={'span'}
            color={status === 'error' ? cssVar.colorError : cssVar.colorTextSecondary}
            fontSize={12}
          >
            {status === 'error'
              ? errorDetail || t('builtins.lobe-video-generation.render.status.error')
              : t(`builtins.lobe-video-generation.render.status.${status}`)}
          </Text>
          {canRetry && (
            <Button loading={isValidating} size={'small'} onClick={retry}>
              {t('builtins.lobe-video-generation.render.retry')}
            </Button>
          )}
        </div>
      )}
      <GenerationCostBadge costUsd={asset?.costUsd} namespace={'video'} />
    </div>
  );
});

VideoGenerationResult.displayName = 'VideoGenerationResult';

export const GenerateVideoRender = memo<
  BuiltinRenderProps<GenerateVideoParams, GenerateVideoState>
>(({ args, pluginError, pluginState }) => {
  const { t } = useTranslation('plugin');
  const task = pluginState?.generation;

  if (pluginError && !task) {
    return (
      <Alert
        showIcon
        description={pluginError.message}
        title={t('builtins.lobe-video-generation.render.generationFailed')}
        type={'error'}
      />
    );
  }

  if (!task) return null;

  const model = pluginState?.model || args?.model;
  const prompt = pluginState?.prompt || args?.prompt;

  return (
    <Block variant={'outlined'} width={'100%'}>
      <div className={styles.header}>
        <div className={styles.meta}>
          <div className={styles.prompt}>{prompt}</div>
          {model && <div className={styles.model}>{model}</div>}
        </div>
      </div>
      <VideoGenerationResult key={`${task.generationId}-${task.asyncTaskId}`} task={task} />
    </Block>
  );
});

GenerateVideoRender.displayName = 'GenerateVideoRender';

export default GenerateVideoRender;
