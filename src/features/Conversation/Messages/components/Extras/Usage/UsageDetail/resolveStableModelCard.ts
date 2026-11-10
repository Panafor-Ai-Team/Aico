import { type LobeDefaultAiModelListItem } from 'model-bank';

/**
 * Stabilize the model card a usage readout renders with.
 *
 * The aiInfra card selector falls back to the static builtin list while the
 * runtime state hydrates — and again whenever access resolution transiently
 * fails and the enabled list empties. Builtin and enabled entries for the same
 * model can carry different pricing, and a pricing-less card flips the readout
 * between credit and token units. Either way the visible counter jumps
 * backward/forward with no usage change at all.
 *
 * Rules (per mounted readout, whose model can still change on a mid-topic
 * model switch):
 * - No card yet: take whatever arrives.
 * - Different model: always adopt the new card (never compare pricing across
 *   models).
 * - Same model: never downgrade to a pricing-less card; transient store states
 *   must not move the number. A genuine pricing change still applies on the
 *   next mount (navigation / new message), so a stale rate can't stick forever.
 */
export const resolveStableModelCard = (
  previous: LobeDefaultAiModelListItem | undefined,
  next: LobeDefaultAiModelListItem | undefined,
): LobeDefaultAiModelListItem | undefined => {
  if (!next) return previous;
  if (!previous) return next;
  if (previous.id !== next.id || previous.providerId !== next.providerId) return next;
  return next.pricing ? next : previous;
};
