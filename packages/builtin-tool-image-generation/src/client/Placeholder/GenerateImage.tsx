'use client';

import type { BuiltinPlaceholderProps } from '@lobechat/types';
import { Block, Text } from '@lobehub/ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { shinyTextStyles } from '@/styles';

import type { GenerateImageParams } from '../../types';
import { formatImageGenerationModelLabel } from '../displayModel';

const styles = createStaticStyles(({ css, cssVar }) => ({
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
  tile: css`
    display: flex;
    flex-direction: column;
    gap: 8px;
    align-items: center;
    justify-content: center;

    aspect-ratio: 1;
    max-width: 220px;
    margin: 12px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 8px;

    background: ${cssVar.colorFillTertiary};
  `,
}));

/**
 * Loading card while `generateImage` is running. Mirrors the result layout
 * without leaking the managed provider id (openrouter / aico).
 */
export const GenerateImagePlaceholder = memo<BuiltinPlaceholderProps<GenerateImageParams>>(
  ({ args }) => {
    const { t } = useTranslation('plugin');
    const prompt = typeof args?.prompt === 'string' ? args.prompt.trim() : undefined;
    const model = formatImageGenerationModelLabel(args?.model, args?.provider);

    return (
      <Block variant={'outlined'} width={'100%'}>
        <div className={styles.header}>
          <div className={styles.meta}>
            <div className={styles.prompt}>
              {prompt || t('builtins.lobe-image-generation.render.generating')}
            </div>
            {model && <div className={styles.model}>{model}</div>}
          </div>
          <span className={styles.status}>
            <Text as={'span'} className={shinyTextStyles.shinyText} fontSize={12}>
              {t('builtins.lobe-image-generation.render.status.processing')}
            </Text>
          </span>
        </div>
        <div className={styles.tile}>
          <Text
            as={'span'}
            className={shinyTextStyles.shinyText}
            color={cssVar.colorTextSecondary}
            fontSize={12}
          >
            {t('builtins.lobe-image-generation.render.generating')}
          </Text>
        </div>
      </Block>
    );
  },
);

GenerateImagePlaceholder.displayName = 'GenerateImagePlaceholder';

export default GenerateImagePlaceholder;
