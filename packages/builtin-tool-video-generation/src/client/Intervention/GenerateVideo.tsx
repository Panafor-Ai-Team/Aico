'use client';

import type { BuiltinInterventionProps } from '@lobechat/types';
import { Block, Flexbox } from '@lobehub/ui';
import { createStaticStyles } from 'antd-style';
import type { VideoModelParamsSchema } from 'model-bank';
import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { estimateVideoGenerationCostUsd, GenerationCostEstimate } from '@/features/GenerationCost';
import { useEnabledVideoModels } from '@/hooks/useEnabledVideoModels';

import { isVideoGenerationProvider } from '../../defaultModel';
import { resolveVideoRequest, selectVideoModel } from '../../ExecutionRuntime';
import type { GenerateVideoParams } from '../../types';

const styles = createStaticStyles(({ css, cssVar }) => ({
  body: css`
    padding-block: 12px;
    padding-inline: 12px;
  `,
  cost: css`
    display: flex;
    gap: 8px;
    align-items: center;
    justify-content: space-between;

    font-size: 12px;
    font-weight: 500;
    color: ${cssVar.colorText};
  `,
  header: css`
    padding-block: 8px;
    padding-inline: 12px;
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};
  `,
  label: css`
    font-size: 12px;
    line-height: 1.6;
    color: ${cssVar.colorTextTertiary};
  `,
  prompt: css`
    padding-block: 6px;
    padding-inline: 10px;
    border-radius: ${cssVar.borderRadius};

    font-size: 12px;
    color: ${cssVar.colorTextSecondary};

    background: ${cssVar.colorFillQuaternary};
  `,
  title: css`
    overflow: hidden;

    font-size: 13px;
    font-weight: 500;
    color: ${cssVar.colorText};
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
}));

/**
 * Shown when the user's approval mode asks before `generateVideo` runs: names
 * the model, the length / quality / frame that will be sent and what it costs.
 */
const GenerateVideoIntervention = memo<BuiltinInterventionProps<GenerateVideoParams>>(
  ({ args }) => {
    const { t } = useTranslation('plugin');
    const { isManagedStatusLoading, list } = useEnabledVideoModels();

    const request = useMemo(() => {
      const provider = args?.provider?.trim();
      const providers = list
        .filter((item) => isVideoGenerationProvider(item.id))
        .filter((item) => !provider || item.id === provider)
        .map((item) => ({
          id: item.id,
          models: item.children.map((model) => ({
            ...model,
            parameters: model.parameters as VideoModelParamsSchema | undefined,
          })),
        }));

      const selection = selectVideoModel(providers, args?.model?.trim());
      if (!selection) return;

      const modelItem = providers
        .find((item) => item.id === selection.provider)
        ?.models.find((model) => model.id === selection.model);
      const { params, settings } = resolveVideoRequest(
        args ?? { prompt: '' },
        selection.parameters,
      );

      return {
        costUsd: modelItem
          ? estimateVideoGenerationCostUsd({
              model: modelItem,
              params,
              provider: selection.provider,
            })
          : undefined,
        hasImage: Boolean(params.imageUrl || (params.imageUrls as string[] | undefined)?.length),
        modelName: modelItem?.displayName || selection.model,
        provider: selection.provider,
        settings,
      };
    }, [args, list]);

    const settingsLine = request
      ? [
          request.settings.duration ? `${request.settings.duration}s` : undefined,
          request.settings.resolution,
          request.settings.aspectRatio,
        ]
          .filter(Boolean)
          .join(' · ')
      : '';

    const statusLabel = request
      ? t('builtins.lobe-video-generation.intervention.description', { model: request.modelName })
      : isManagedStatusLoading
        ? t('builtins.lobe-video-generation.intervention.loading')
        : t('builtins.lobe-video-generation.intervention.noModels');

    return (
      <Block variant={'outlined'}>
        <div className={styles.header}>
          <div className={styles.title}>
            {t('builtins.lobe-video-generation.intervention.title')}
          </div>
        </div>
        <Flexbox className={styles.body} gap={12}>
          <div className={styles.label}>{statusLabel}</div>

          {args?.prompt && (
            <div className={styles.prompt} dir={'auto'}>
              {args.prompt}
            </div>
          )}

          {request && settingsLine && (
            <div className={styles.label}>
              {request.hasImage
                ? t('builtins.lobe-video-generation.intervention.settingsWithImage', {
                    settings: settingsLine,
                  })
                : settingsLine}
            </div>
          )}

          {request?.costUsd !== undefined && (
            <div className={styles.cost}>
              <span>{t('builtins.lobe-video-generation.intervention.cost')}</span>
              <GenerationCostEstimate costUsd={request.costUsd} provider={request.provider} />
            </div>
          )}

          <div className={styles.label}>
            {t('builtins.lobe-video-generation.intervention.hint')}
          </div>
        </Flexbox>
      </Block>
    );
  },
);

GenerateVideoIntervention.displayName = 'GenerateVideoIntervention';

export default GenerateVideoIntervention;
