import type { ModelUsage } from '@lobechat/types';

import { formatPiTokens, rawUsdToPiTokens } from '@/features/AicoBilling/piToken';

/** Prefer structured `usage.cost`; fall back to deprecated flat `metadata.cost`. */
export const resolveMessageCost = (
  usage?: ModelUsage,
  // `object` rather than `Record<string, unknown>`: callers pass the
  // `MessageMetadata` interface, which carries no implicit index signature.
  metadata?: object | null,
): number | undefined => {
  if (typeof usage?.cost === 'number' && Number.isFinite(usage.cost)) return usage.cost;
  const legacy = (metadata as { cost?: unknown } | null | undefined)?.cost;
  if (typeof legacy === 'number' && Number.isFinite(legacy)) return legacy;
  return undefined;
};

/**
 * Format a raw USD cost as π tokens (1 π = 1000 CVC). Costs arrive as raw
 * upstream USD after the identity pricing context.
 */
export const formatMessageCostUsd = (cost: number): string => {
  if (!Number.isFinite(cost)) return formatPiTokens(0);
  return formatPiTokens(rawUsdToPiTokens(cost));
};
