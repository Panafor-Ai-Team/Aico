'use client';

import type { BuiltinInterventionProps } from '@lobechat/types';
import { Block, Flexbox } from '@lobehub/ui';
import { Select } from '@lobehub/ui/base-ui';
import { createStaticStyles } from 'antd-style';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useConversationStore } from '@/features/Conversation/store';
import { dataSelectors } from '@/features/Conversation/store/slices/data/selectors';
import { useEnabledImageModels } from '@/hooks/useEnabledImageModels';

import { setConfirmedImageModel } from '../../confirmation';
import type { GenerateImageParams } from '../../types';
import {
  type ImageModelOption,
  imageModelOptionKey,
  resolveDefaultImageModelOption,
} from './resolveDefaultImageModel';

const styles = createStaticStyles(({ css, cssVar }) => ({
  body: css`
    padding-block: 12px;
    padding-inline: 12px;
  `,
  /**
   * Model ids and provider names are always Latin. Isolating them keeps the
   * punctuation on the correct side when the surrounding UI is RTL (fa-IR).
   */
  code: css`
    unicode-bidi: isolate;

    font-family: ${cssVar.fontFamilyCode};
    font-size: 12px;
    color: ${cssVar.colorTextSecondary};
    direction: ltr;
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
 * One-time confirmation shown the first time a conversation generates an image.
 *
 * It names the model that will be charged and lets the user swap it for any
 * image model on their account (personal wallet or organization) before the
 * generation starts. The pick is remembered for the conversation, so the rest of
 * the chat generates without asking again.
 */
const GenerateImageIntervention = memo<BuiltinInterventionProps<GenerateImageParams>>(
  ({ args, messageId, onArgsChange, registerBeforeApprove }) => {
    const { t } = useTranslation('plugin');
    const { list } = useEnabledImageModels();
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

    const defaultOption = useMemo(
      () =>
        resolveDefaultImageModelOption(options, { model: args?.model, provider: args?.provider }),
      [args?.model, args?.provider, options],
    );

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

    // Write the choice into the tool call right before it is approved: the tool
    // then runs on exactly the model shown here, and the conversation stops
    // asking.
    useEffect(() => {
      if (!registerBeforeApprove) return;

      return registerBeforeApprove('image-generation-model-confirm', async () => {
        if (!selected) return;

        setConfirmedImageModel(topicId, { model: selected.model, provider: selected.provider });

        if (args?.model !== selected.model || args?.provider !== selected.provider) {
          await onArgsChange?.({ ...args, model: selected.model, provider: selected.provider });
        }
      });
    }, [args, onArgsChange, registerBeforeApprove, selected, topicId]);

    // Once the user overrides the proposal, the copy must stop calling it "the
    // default" — it is now their pick.
    const isDefaultSelected =
      !!defaultOption &&
      !!selected &&
      imageModelOptionKey(selected) === imageModelOptionKey(defaultOption);

    const handleChange = useCallback((value: unknown) => {
      if (typeof value === 'string') setSelectedKey(value);
    }, []);

    const selectOptions = useMemo(
      () =>
        options.map((option) => ({
          label: `${option.displayName} · ${option.providerName}`,
          value: imageModelOptionKey(option),
        })),
      [options],
    );

    return (
      <Block variant={'outlined'}>
        <div className={styles.header}>
          <div className={styles.title}>
            {t('builtins.lobe-image-generation.intervention.title')}
          </div>
        </div>
        <Flexbox className={styles.body} gap={12}>
          <div className={styles.label}>
            {selected
              ? t(
                  isDefaultSelected
                    ? 'builtins.lobe-image-generation.intervention.description'
                    : 'builtins.lobe-image-generation.intervention.descriptionChanged',
                  { model: selected.displayName },
                )
              : t('builtins.lobe-image-generation.intervention.noModels')}
          </div>

          {args?.prompt && (
            <div className={styles.prompt} dir={'auto'}>
              {args.prompt}
            </div>
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
              {selected && <span className={styles.code}>{imageModelOptionKey(selected)}</span>}
            </Flexbox>
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
