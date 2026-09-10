import { type ModelPerformance, type ModelUsage } from '@lobechat/types';
import { Center, Flexbox, Icon } from '@lobehub/ui';
import { Popover } from '@lobehub/ui/base-ui';
import { createStaticStyles } from 'antd-style';
import { CoinsIcon } from 'lucide-react';
import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { BrandedModelIcon } from '@/components/Branding/BrandedModelIcon';
import { aiModelSelectors, useAiInfraStore } from '@/store/aiInfra';
import { useGlobalStore } from '@/store/global';
import { systemStatusSelectors } from '@/store/global/selectors';
import { type LooseTFunction } from '@/types/looseTranslation';
import { formatNumber } from '@/utils/format';

import { formatMessageCostUsd, resolveMessageCost } from './resolveMessageCost';
import { resolveCostModelId, resolveMessageModelName } from './resolveMessageModelName';

const styles = createStaticStyles(({ css, cssVar }) => ({
  chip: css`
    cursor: pointer;

    width: 28px;
    height: 28px;
    border-radius: 6px;

    color: ${cssVar.colorText};

    :hover {
      background: ${cssVar.colorFillTertiary};
    }
  `,
  costValue: css`
    font-size: 13px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    color: ${cssVar.colorText};
  `,
  detailRow: css`
    display: flex;
    gap: 16px;
    align-items: center;
    justify-content: space-between;

    min-width: 200px;

    font-size: 12px;
    color: ${cssVar.colorTextSecondary};
  `,
  detailValue: css`
    font-weight: 500;
    font-variant-numeric: tabular-nums;
    color: ${cssVar.colorText};
  `,
  modelName: css`
    overflow: hidden;

    font-size: 12px;
    font-weight: 500;
    color: ${cssVar.colorText};
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  modelRow: css`
    display: flex;
    gap: 6px;
    align-items: center;

    min-width: 0;
    padding-block-end: 8px;
    border-block-end: 1px solid ${cssVar.colorSplit};
  `,
  sectionTitle: css`
    margin-block-end: 4px;
    font-size: 11px;
    font-weight: 500;
    color: ${cssVar.colorTextDescription};
  `,
}));

type DetailRow = { key: string; label: string; value: string };

const buildUsageDetailRows = (
  usage: ModelUsage | undefined,
  performance: ModelPerformance | undefined,
  t: LooseTFunction,
): DetailRow[] => {
  if (!usage) return [];

  const rows: DetailRow[] = [];
  const push = (key: string, label: string, value: number | undefined) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return;
    rows.push({ key, label, value: formatNumber(value) });
  };

  push('input', t('messages.tokenDetails.inputTitle'), usage.totalInputTokens);
  push('inputText', t('messages.tokenDetails.inputText'), usage.inputTextTokens);
  push('inputCached', t('messages.tokenDetails.inputCached'), usage.inputCachedTokens);
  push(
    'inputWriteCached',
    t('messages.tokenDetails.inputWriteCached'),
    usage.inputWriteCacheTokens,
  );
  push('inputUncached', t('messages.tokenDetails.inputUncached'), usage.inputCacheMissTokens);
  push('inputAudio', t('messages.tokenDetails.inputAudio'), usage.inputAudioTokens);
  push('inputCitation', t('messages.tokenDetails.inputCitation'), usage.inputCitationTokens);
  push('inputTool', t('messages.tokenDetails.inputTool'), usage.inputToolTokens);

  push('output', t('messages.tokenDetails.outputTitle'), usage.totalOutputTokens);
  push('outputText', t('messages.tokenDetails.outputText'), usage.outputTextTokens);
  push('reasoning', t('messages.tokenDetails.reasoning'), usage.outputReasoningTokens);
  push('outputAudio', t('messages.tokenDetails.outputAudio'), usage.outputAudioTokens);
  push('outputImage', t('messages.tokenDetails.outputImage'), usage.outputImageTokens);

  push('total', t('messages.tokenDetails.total'), usage.totalTokens);

  if (performance?.tps) {
    rows.push({
      key: 'tps',
      label: t('messages.tokenDetails.speed.tps.title'),
      value: formatNumber(performance.tps, 1),
    });
  }
  if (performance?.ttft) {
    rows.push({
      key: 'ttft',
      label: t('messages.tokenDetails.speed.ttft.title'),
      value: `${formatNumber(performance.ttft / 1000, 2)}s`,
    });
  }

  return rows;
};

interface MessageCostBadgeProps {
  // Callers pass `MessageMetadata`, an interface — interfaces have no implicit
  // index signature, so `Record<string, unknown>` does not accept them.
  metadata?: object | null;
  model?: string | null;
  performance?: ModelPerformance;
  provider?: string | null;
  usage?: ModelUsage;
}

const MessageCostBadge = memo<MessageCostBadgeProps>(
  ({ usage, metadata, performance, model, provider }) => {
    const { t } = useTranslation('chat');
    const isShowCredit = useGlobalStore(systemStatusSelectors.isShowCredit);
    const costModel = resolveCostModelId(model, metadata);
    const modelCard = useAiInfraStore(
      aiModelSelectors.getModelCard(costModel ?? '', provider ?? ''),
    );

    const cost = useMemo(() => resolveMessageCost(usage, metadata), [usage, metadata]);
    const detailRows = useMemo(
      () => buildUsageDetailRows(usage, performance, t),
      [usage, performance, t],
    );

    if (isShowCredit) return null;
    if (cost === undefined || cost <= 0) return null;

    const amount = formatMessageCostUsd(cost);
    const label = t('messageAction.cost');

    const { name: modelName, showIcon } = resolveMessageModelName({
      displayName: modelCard?.displayName,
      model: costModel,
      provider,
    });

    return (
      <Popover
        placement="top"
        trigger="hover"
        content={
          <Flexbox gap={12} style={{ minWidth: 220, padding: 4 }}>
            {/* The model heads the card: it names what produced this reply, and
                every number below is only meaningful once you know which model
                they belong to. */}
            {modelName && (
              <div className={styles.modelRow}>
                {showIcon && <BrandedModelIcon model={costModel!} size={16} type={'mono'} />}
                <span className={styles.modelName}>{modelName}</span>
              </div>
            )}

            <div>
              <div className={styles.sectionTitle}>{label}</div>
              <div className={styles.costValue}>{amount}</div>
            </div>

            {detailRows.length > 0 && (
              <Flexbox gap={6}>
                {detailRows.map((row) => (
                  <div className={styles.detailRow} key={row.key}>
                    <span>{row.label}</span>
                    <span className={styles.detailValue}>{row.value}</span>
                  </div>
                ))}
              </Flexbox>
            )}
          </Flexbox>
        }
      >
        <Center
          horizontal
          aria-label={modelName ? `${label}: ${amount} · ${modelName}` : `${label}: ${amount}`}
          className={styles.chip}
        >
          <Icon icon={CoinsIcon} size={14} />
        </Center>
      </Popover>
    );
  },
);

MessageCostBadge.displayName = 'MessageCostBadge';

export default MessageCostBadge;
