'use client';

import { formatPriceByCurrency } from '@lobechat/utils';
import { createStaticStyles } from 'antd-style';
import { memo } from 'react';

import { PiTokenIcon } from '@/features/AicoBilling/PiTokenIcon';
import {
  formatPiRate,
  isPiPricingProvider,
} from '@/features/ModelSwitchPanel/hooks/useModelDetailPanel';

const styles = createStaticStyles(({ css }) => ({
  amount: css`
    display: inline-flex;
    gap: 3px;
    align-items: center;
    font-variant-numeric: tabular-nums;
  `,
}));

/**
 * Pre-generation estimate: π for managed / branding providers (what the wallet
 * is charged), `$` for direct providers — the same units as the model picker.
 */
export const GenerationCostEstimate = memo<{ costUsd?: number; provider?: string }>(
  ({ costUsd, provider }) => {
    if (typeof costUsd !== 'number' || !Number.isFinite(costUsd) || costUsd <= 0) return null;

    return isPiPricingProvider(provider) ? (
      <span className={styles.amount}>
        ~ {formatPiRate(costUsd)}
        <PiTokenIcon size={12} />
      </span>
    ) : (
      <span className={styles.amount}>~ ${formatPriceByCurrency(costUsd)}</span>
    );
  },
);

GenerationCostEstimate.displayName = 'GenerationCostEstimate';
