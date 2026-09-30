'use client';

import type { BuiltinInterventionProps } from '@lobechat/types';
import { Block, Flexbox } from '@lobehub/ui';
import { Select } from '@lobehub/ui/base-ui';
import { createStaticStyles } from 'antd-style';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useConversationStore } from '@/features/Conversation/store';
import { dataSelectors } from '@/features/Conversation/store/slices/data/selectors';
import { estimateImageGenerationCostUsd, GenerationCostEstimate } from '@/features/GenerationCost';
import { GenerationSettingField } from '@/features/GenerationSettings';
import { useEnabledImageModels } from '@/hooks/useEnabledImageModels';

import { getConfirmedImageModel, setConfirmedImageModel } from '../../confirmation';
import { imageSchemaDefaults, resolveImageNum } from '../../ExecutionRuntime';
import type { GenerateImageParams } from '../../types';
import {
  applyImageSettings,
  type ImageSettingKey,
  resolveImageSettingFields,
} from './imageSettings';
import {
  type ImageModelOption,
  imageModelOptionKey,
  resolveDefaultImageModelOption,
  toImageModelSelectOptions,
} from './resolveDefaultImageModel';

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
    display: flex;
    gap: 8px;
    align-items: center;
    justify-content: space-between;

    min-width: 0;
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
  referenceGrid: css`
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  `,
  referenceThumb: css`
    display: block;

    width: 56px;
    height: 56px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusSM};

    object-fit: cover;
  `,
  select: css`
    width: 100%;
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
 * Confirmation shown before every interactive image generation.
 *
 * It names the model that will be charged, lets the user swap it for any image
 * model on their account (personal wallet or organization) and pick the
 * quality / size the model offers, and shows the estimated cost. The model pick
 * becomes the proposal for the next image in this conversation.
 */
const GenerateImageIntervention = memo<BuiltinInterventionProps<GenerateImageParams>>(
  ({ args, messageId, onArgsChange, registerBeforeApprove }) => {
    const { t } = useTranslation('plugin');
    const { isLoading, list } = useEnabledImageModels();
    const topicId = useConversationStore(
      (s) => dataSelectors.getDbMessageById(messageId)(s)?.topicId,
    );

    const options = useMemo<ImageModelOption[]>(
      () =>
        (list || []).flatMap((provider) =>
          (provider.children || []).map((model) => ({
            displayName: model.displayName || model.id,
            model: model.id,
            provider: provider.id,
            providerName: provider.name || provider.id,
          })),
        ),
      [list],
    );

    const defaultOption = useMemo(() => {
      const previous = args?.model ? undefined : getConfirmedImageModel(topicId);
      return resolveDefaultImageModelOption(options, {
        model: args?.model ?? previous?.model,
        provider: args?.model ? args?.provider : previous?.provider,
      });
    }, [args?.model, args?.provider, options, topicId]);

    const [selectedKey, setSelectedKey] = useState<string | undefined>();

    // The model list hydrates asynchronously; adopt the resolved default as soon
    // as it lands, but never overwrite a pick the user already made.
    useEffect(() => {
      setSelectedKey(
        (current) => current ?? (defaultOption ? imageModelOptionKey(defaultOption) : undefined),
      );
    }, [defaultOption]);

    const selected = useMemo(
      () => options.find((option) => imageModelOptionKey(option) === selectedKey) ?? defaultOption,
      [defaultOption, options, selectedKey],
    );

    const selectedModelItem = useMemo(
      () =>
        selected
          ? list
              ?.find((provider) => provider.id === selected.provider)
              ?.children.find((model) => model.id === selected.model)
          : undefined,
      [list, selected],
    );

    const [settingPicks, setSettingPicks] = useState<Partial<Record<ImageSettingKey, string>>>({});

    const settingFields = useMemo(
      () =>
        resolveImageSettingFields(selectedModelItem?.parameters, args?.parameters, settingPicks),
      [args?.parameters, selectedModelItem?.parameters, settingPicks],
    );

    const parameters = useMemo(
      () => applyImageSettings(args?.parameters, settingFields),
      [args?.parameters, settingFields],
    );

    const costUsd = useMemo(() => {
      if (!selected || !selectedModelItem) return;

      return estimateImageGenerationCostUsd({
        imageNum: resolveImageNum(args?.imageNum),
        model: selectedModelItem,
        params: { ...imageSchemaDefaults(selectedModelItem.parameters), ...parameters },
        provider: selected.provider,
      });
    }, [args?.imageNum, parameters, selected, selectedModelItem]);

    // Write the choices into the tool call right before it is confirmed: the tool
    // then runs on exactly the model and settings shown here. Refuse while models
    // are still loading or none are available.
    useEffect(() => {
      if (!registerBeforeApprove) return;

      return registerBeforeApprove('image-generation-model-confirm', async () => {
        if (isLoading) {
          throw new Error('Image models are still loading. Wait a moment and try again.');
        }
        if (!selected) {
          throw new Error('No image generation model is available on this account yet.');
        }

        setConfirmedImageModel(topicId, { model: selected.model, provider: selected.provider });

        await onArgsChange?.({
          ...args,
          model: selected.model,
          parameters,
          provider: selected.provider,
        });
      });
    }, [args, isLoading, onArgsChange, parameters, registerBeforeApprove, selected, topicId]);

    const settingLabel = useCallback(
      (key: ImageSettingKey) => t(`builtins.lobe-image-generation.intervention.settings.${key}`),
      [t],
    );

    const optionLabel = useCallback(
      (value: string) => {
        const known = ['auto', 'high', 'low', 'medium'];
        return known.includes(value.toLowerCase())
          ? t(`builtins.lobe-image-generation.intervention.option.${value.toLowerCase() as 'auto'}`)
          : value;
      },
      [t],
    );

    // Once the user overrides the proposal, the copy must stop calling it "the
    // default" — it is now their pick.
    const isDefaultSelected =
      !!defaultOption &&
      !!selected &&
      imageModelOptionKey(selected) === imageModelOptionKey(defaultOption);

    const handleChange = useCallback((value: unknown) => {
      if (typeof value === 'string') setSelectedKey(value);
    }, []);

    const selectOptions = useMemo(() => toImageModelSelectOptions(options), [options]);

    const referenceUrls = useMemo(() => {
      const urls = [
        ...(typeof args?.imageUrl === 'string' && args.imageUrl.trim()
          ? [args.imageUrl.trim()]
          : []),
        ...(Array.isArray(args?.imageUrls) ? args.imageUrls : []),
      ];
      return [
        ...new Set(urls.filter((url) => /^https?:\/\//i.test(url) || url.startsWith('data:'))),
      ];
    }, [args?.imageUrl, args?.imageUrls]);

    const statusLabel = isLoading
      ? t('builtins.lobe-image-generation.intervention.loading')
      : selected
        ? t(
            isDefaultSelected
              ? 'builtins.lobe-image-generation.intervention.description'
              : 'builtins.lobe-image-generation.intervention.descriptionChanged',
            { model: selected.displayName },
          )
        : t('builtins.lobe-image-generation.intervention.noModels');

    return (
      <Block variant={'outlined'}>
        <div className={styles.header}>
          <div className={styles.title}>
            {t('builtins.lobe-image-generation.intervention.title')}
          </div>
        </div>
        <Flexbox className={styles.body} gap={12}>
          <div className={styles.label}>{statusLabel}</div>

          {args?.prompt && (
            <div className={styles.prompt} dir={'auto'}>
              {args.prompt}
            </div>
          )}

          {referenceUrls.length > 0 && (
            <Flexbox gap={6}>
              <div className={styles.label}>
                {t('builtins.lobe-image-generation.intervention.referenceLabel')}
              </div>
              <div className={styles.referenceGrid}>
                {referenceUrls.map((url) => (
                  <img alt="" className={styles.referenceThumb} key={url} src={url} />
                ))}
              </div>
            </Flexbox>
          )}

          {options.length > 0 && (
            <Flexbox gap={6}>
              <div className={styles.label}>
                {t('builtins.lobe-image-generation.intervention.modelLabel')}
              </div>
              <Select
                className={styles.select}
                options={selectOptions}
                size={'small'}
                value={selectedKey}
                variant={'filled'}
                onChange={handleChange}
              />
            </Flexbox>
          )}

          {settingFields.length > 0 && (
            <Flexbox horizontal gap={8} wrap={'wrap'}>
              {settingFields.map((field) => (
                <GenerationSettingField
                  key={field.key}
                  label={settingLabel(field.key)}
                  options={field.options.map((value) => ({ label: optionLabel(value), value }))}
                  value={field.value}
                  onChange={(value) =>
                    setSettingPicks((picks) => ({ ...picks, [field.key]: value }))
                  }
                />
              ))}
            </Flexbox>
          )}

          {costUsd !== undefined && (
            <div className={styles.cost}>
              <span>{t('builtins.lobe-image-generation.intervention.cost')}</span>
              <GenerationCostEstimate costUsd={costUsd} provider={selected?.provider} />
            </div>
          )}

          <div className={styles.label}>
            {t('builtins.lobe-image-generation.intervention.hint')}
          </div>
        </Flexbox>
      </Block>
    );
  },
);

GenerateImageIntervention.displayName = 'GenerateImageIntervention';

export default GenerateImageIntervention;
