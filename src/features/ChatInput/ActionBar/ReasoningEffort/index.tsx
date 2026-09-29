'use client';

import { Flexbox } from '@lobehub/ui';
import { Select } from '@lobehub/ui/base-ui';
import { createStaticStyles } from 'antd-style';
import { memo, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { useAgentId } from '@/features/ChatInput/hooks/useAgentId';
import { useUpdateAgentConfig } from '@/features/ChatInput/hooks/useUpdateAgentConfig';
import { useAgentStore } from '@/store/agent';
import { chatConfigByIdSelectors } from '@/store/agent/selectors';
import { aiModelSelectors, useAiInfraStore } from '@/store/aiInfra';

import { useAgentModelSelection } from '../../hooks/useAgentModelSelection';
import { useActionBarContext } from '../context';
import { useParamsModelConfig } from '../Params/useParamsModelConfig';

const REASONING_EFFORT_LEVELS = ['low', 'medium', 'high'] as const;
type ReasoningEffortLevel = (typeof REASONING_EFFORT_LEVELS)[number];

const styles = createStaticStyles(({ css, cssVar }) => ({
  root: css`
    display: flex;
    align-items: center;
    height: var(--action-block-size, 32px);
    padding-inline: 2px;
  `,
  select: css`
    min-width: 96px;

    /* Match the compact action-bar footprint next to the model icon */
    .ant-select-selector {
      border-radius: 16px !important;
      background: transparent !important;
    }

    &:hover .ant-select-selector {
      background: ${cssVar.colorFillSecondary} !important;
    }
  `,
}));

/**
 * Inline thinking-level control shown beside the model picker when the selected
 * model advertises `reasoningEffort` in extendParams. Writes
 * `chatConfig.reasoningEffort` → wire `reasoning_effort`.
 */
const ReasoningEffort = memo(() => {
  const { t } = useTranslation('setting');
  const { actionSize } = useActionBarContext();
  const blockSize = actionSize?.blockSize ?? 32;
  const agentId = useAgentId();
  const { updateAgentChatConfig } = useUpdateAgentConfig();
  const { canSelectModel } = useAgentModelSelection(agentId);
  const { model, provider } = useParamsModelConfig(agentId);

  const extendParams = useAiInfraStore(aiModelSelectors.modelExtendParams(model, provider));
  const supportsReasoningEffort = Boolean(extendParams?.includes('reasoningEffort'));

  const agentConfig = useAgentStore((s) => chatConfigByIdSelectors.getChatConfigById(agentId)(s));

  const value = useMemo((): ReasoningEffortLevel => {
    const raw = agentConfig.reasoningEffort;
    if (typeof raw === 'string' && REASONING_EFFORT_LEVELS.includes(raw as ReasoningEffortLevel)) {
      return raw as ReasoningEffortLevel;
    }
    return 'medium';
  }, [agentConfig.reasoningEffort]);

  const options = useMemo(
    () =>
      REASONING_EFFORT_LEVELS.map((level) => ({
        label: t(`settingModel.reasoningEffort.options.${level}`),
        value: level,
      })),
    [t],
  );

  const handleChange = useCallback(
    (next: unknown) => {
      if (typeof next !== 'string') return;
      if (!REASONING_EFFORT_LEVELS.includes(next as ReasoningEffortLevel)) return;
      void updateAgentChatConfig({ reasoningEffort: next as ReasoningEffortLevel });
    },
    [updateAgentChatConfig],
  );

  if (!supportsReasoningEffort) return null;

  return (
    <Flexbox
      className={styles.root}
      style={{ ['--action-block-size' as string]: `${blockSize}px` }}
      title={t('settingModel.reasoningEffort.title')}
    >
      <Select
        className={styles.select}
        disabled={!canSelectModel}
        options={options}
        size={'small'}
        value={value}
        variant={'borderless'}
        onChange={handleChange}
      />
    </Flexbox>
  );
});

ReasoningEffort.displayName = 'ReasoningEffort';

export default ReasoningEffort;
