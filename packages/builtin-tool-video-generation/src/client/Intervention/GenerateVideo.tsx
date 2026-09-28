'use client';

import type { BuiltinInterventionProps } from '@lobechat/types';
import { Block, Flexbox } from '@lobehub/ui';
import { createStaticStyles } from 'antd-style';
import { resolveVideoModelParamsSchema, type VideoModelParamsSchema } from 'model-bank';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { estimateVideoGenerationCostUsd, GenerationCostEstimate } from '@/features/GenerationCost';
import { GenerationSettingField } from '@/features/GenerationSettings';
import { useEnabledVideoModels } from '@/hooks/useEnabledVideoModels';

import { isVideoGenerationProvider } from '../../defaultModel';
import { resolveVideoRequest, selectVideoModel } from '../../ExecutionRuntime';
import type { GenerateVideoParams } from '../../types';
import {
  resolveVideoSettingFields,
  toVideoSettingArgs,
  type VideoSettingKey,
} from './videoSettings';

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
 * Confirmation shown before every interactive `generateVideo` call: names the
 * model, lets the user pick quality / frame shape / duration, and shows what
 * the video will cost.
 */
const GenerateVideoIntervention = memo<BuiltinInterventionProps<GenerateVideoParams>>(
  ({ args, onArgsChange, registerBeforeApprove }) => {
    const { t } = useTranslation('plugin');
    const { isManagedStatusLoading, list } = useEnabledVideoModels();
    const [settingPicks, setSettingPicks] = useState<Partial<Record<VideoSettingKey, string>>>({});

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
      const schema = resolveVideoModelParamsSchema(selection.parameters);
      const baseArgs = args ?? { prompt: '' };
      const pickedArgs = toVideoSettingArgs(
        resolveVideoSettingFields(schema, resolveVideoRequest(baseArgs, schema).settings).map(
          (field) =>
            settingPicks[field.key] && field.options.includes(settingPicks[field.key]!)
              ? { ...field, value: settingPicks[field.key]! }
              : field,
        ),
      );
      const { params, settings } = resolveVideoRequest({ ...baseArgs, ...pickedArgs }, schema);

      return {
        costUsd: modelItem
          ? estimateVideoGenerationCostUsd({
              model: modelItem,
              params,
              provider: selection.provider,
            })
          : undefined,
        fields: resolveVideoSettingFields(schema, settings),
        hasImage: Boolean(params.imageUrl || (params.imageUrls as string[] | undefined)?.length),
        model: selection.model,
        modelName: modelItem?.displayName || selection.model,
        provider: selection.provider,
      };
    }, [args, list, settingPicks]);

    // Write the model and picks into the tool call right before it is confirmed,
    // so the video is generated with exactly what this card shows and prices.
    useEffect(() => {
      if (!registerBeforeApprove) return;

      return registerBeforeApprove('video-generation-settings-confirm', async () => {
        if (!request) {
          throw new Error(
            isManagedStatusLoading
              ? 'Video models are still loading. Wait a moment and try again.'
              : 'No video generation model is available on this account yet.',
          );
        }

        await onArgsChange?.({
          ...args,
          ...toVideoSettingArgs(request.fields),
          model: request.model,
          provider: request.provider,
        });
      });
    }, [args, isManagedStatusLoading, onArgsChange, registerBeforeApprove, request]);

    const optionLabel = useCallback(
      (key: VideoSettingKey, value: string) =>
        key === 'duration'
          ? t('builtins.lobe-video-generation.intervention.durationValue', { seconds: value })
          : value,
      [t],
    );

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

          {request && request.fields.length > 0 && (
            <Flexbox horizontal gap={8} wrap={'wrap'}>
              {request.fields.map((field) => (
                <GenerationSettingField
                  key={field.key}
                  label={t(`builtins.lobe-video-generation.intervention.settings.${field.key}`)}
                  value={field.value}
                  options={field.options.map((value) => ({
                    label: optionLabel(field.key, value),
                    value,
                  }))}
                  onChange={(value) =>
                    setSettingPicks((picks) => ({ ...picks, [field.key]: value }))
                  }
                />
              ))}
            </Flexbox>
          )}

          {request?.hasImage && (
            <div className={styles.label}>
              {t('builtins.lobe-video-generation.intervention.usesImage')}
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
