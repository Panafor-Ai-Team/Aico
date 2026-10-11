import type { ModelUsage } from '@lobechat/types';

/**
 * Monotonic merge for `usage` stream events.
 *
 * A single chat stream can carry several `usage` events (final chunk, trailing
 * tool/result chunks, usage-only chunks). The consumer keeps exactly one
 * running snapshot, so a last-wins replace lets a trailing zero-total artifact
 * (`{ total_tokens: 0 }` on tool chunks) or a partial snapshot wipe out the
 * real totals — the token counter visibly drops and only recovers on the next
 * fetch. Merge instead:
 *
 * - Token counts only ever grow (per-field max; a missing field means
 *   "unknown", never 0, so partial snapshots can't drag a known total down).
 * - `cost` follows the latest reported figure (rates can be corrected;
 *   cementing a stale/phantom cost would repeat the wallet-debit flicker).
 * - Events carrying no information (no positive token count and no cost) are
 *   ignored outright instead of blanking the snapshot.
 */
export const mergeStreamUsage = (
  previous: ModelUsage | undefined,
  next: ModelUsage | undefined,
): ModelUsage | undefined => {
  if (!next) return previous;
  if (!previous) return next;

  if (!isInformativeUsage(next)) return previous;

  const merged: ModelUsage = { ...previous };

  for (const [key, nextValue] of Object.entries(next) as [keyof ModelUsage, unknown][]) {
    if (nextValue === undefined) continue;

    if (key === 'cost') {
      if (typeof nextValue === 'number' && Number.isFinite(nextValue)) merged.cost = nextValue;
      continue;
    }

    if (typeof nextValue !== 'number' || !Number.isFinite(nextValue)) {
      (merged[key] as unknown) = nextValue;
      continue;
    }

    const prevValue = previous[key];
    (merged[key] as number) =
      typeof prevValue === 'number' && Number.isFinite(prevValue)
        ? Math.max(prevValue, nextValue)
        : nextValue;
  }

  return merged;
};

const isPositiveFinite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

const isInformativeUsage = (usage: ModelUsage): boolean => {
  if (typeof usage.cost === 'number' && Number.isFinite(usage.cost)) return true;

  return Object.entries(usage).some(([key, value]) => key !== 'cost' && isPositiveFinite(value));
};
