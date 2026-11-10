import { isReasoningBilledTwice, type Pricing } from 'model-bank';

import {
  formatCvcCoefficient,
  formatIsolatedCoefficient,
  isolateLtr,
  rawUsdToCvcCoefficient,
} from '@/features/AicoBilling/piToken';
import { getUnitRateByName } from '@/utils/index';

import { isPiPricingProvider } from './hooks/useModelDetailPanel';

export interface RowCoefficient {
  /** CVC counts thinking tokens twice for this model: the real cost exceeds `label`. */
  billedTwice: boolean;
  /** LTR-isolated, e.g. `4×` or `↑1× ↓4×`. */
  label: string;
}

const positive = (rate?: number) => (typeof rate === 'number' && rate > 0 ? rate : undefined);

/**
 * The usage coefficient shown on a model row, in the same convention as the
 * details popup (`formatTokenCoefficient` at the server's CVC rate). Only managed
 * (π) chat models have one; direct providers keep dollar pricing, and
 * image/video/embedding models have no per-token coefficient.
 */
export const getRowCoefficient = (
  pricing: Pricing | undefined,
  provider: string | undefined,
  modelId: string | undefined,
): RowCoefficient | undefined => {
  if (!pricing || !isPiPricingProvider(provider)) return undefined;

  const input = positive(getUnitRateByName(pricing, 'textInput'));
  if (!input) return undefined;
  const output = positive(getUnitRateByName(pricing, 'textOutput'));

  const billedTwice = isReasoningBilledTwice(modelId);
  const inputCoefficient = rawUsdToCvcCoefficient(input);

  if (!output || output === input) {
    return { billedTwice, label: formatIsolatedCoefficient(inputCoefficient) };
  }

  const outputCoefficient = rawUsdToCvcCoefficient(output);
  return {
    billedTwice,
    label: isolateLtr(
      `↑${formatCvcCoefficient(inputCoefficient)} ↓${formatCvcCoefficient(outputCoefficient)}`,
    ),
  };
};
