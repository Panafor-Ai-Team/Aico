'use client';

import type { BuiltinPlaceholderProps } from '@lobechat/types';
import { Block, Text } from '@lobehub/ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { GenerationElapsedTime } from '@/components/GenerationElapsedTime';
import NeuralNetworkLoading from '@/components/NeuralNetworkLoading';
import { shinyTextStyles } from '@/styles';

import type { GenerateVideoParams } from '../../types';
import { styles } from '../Render/GenerateVideo';

/**
 * Registered as both placeholder and streaming renderer; both paths pass
 * `toolCallId`. `startTime` (the running tool-call operation start) keeps this
 * timer in step with the tool-row timer.
 */
type GenerateVideoPlaceholderProps = BuiltinPlaceholderProps<GenerateVideoParams> & {
  startTime?: number;
  toolCallId?: string;
};

/** Loading card while `generateVideo` is running; mirrors the result layout. */
export const GenerateVideoPlaceholder = memo<GenerateVideoPlaceholderProps>(
  ({ args, startTime, toolCallId }) => {
    const { t } = useTranslation('plugin');
    const prompt = typeof args?.prompt === 'string' ? args.prompt.trim() : undefined;
    const model = typeof args?.model === 'string' ? args.model.trim() : undefined;

    return (
      <Block variant={'outlined'} width={'100%'}>
        <div className={styles.header}>
          <div className={styles.meta}>
            <div className={styles.prompt}>
              {prompt || t('builtins.lobe-video-generation.render.generating')}
            </div>
            {model && <div className={styles.model}>{model}</div>}
          </div>
          <span className={styles.status}>
            <Text as={'span'} className={shinyTextStyles.shinyText} fontSize={12}>
              {t('builtins.lobe-video-generation.render.status.processing')}
            </Text>
          </span>
        </div>
        <div className={styles.body}>
          <div className={styles.placeholder}>
            <NeuralNetworkLoading size={48} />
            {toolCallId && (
              <GenerationElapsedTime isActive startTime={startTime} timerKey={toolCallId} />
            )}
          </div>
        </div>
      </Block>
    );
  },
);

GenerateVideoPlaceholder.displayName = 'GenerateVideoPlaceholder';

export default GenerateVideoPlaceholder;
