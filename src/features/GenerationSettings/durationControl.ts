/** Up to this many lengths fit side by side as segment buttons; more get a slider. */
export const MAX_SEGMENTED_DURATIONS = 5;

export type DurationControl = 'fixed' | 'segmented' | 'slider';

/** How the confirm card lets the user pick among `count` video lengths. */
export const resolveDurationControl = (count: number): DurationControl => {
  if (count <= 1) return 'fixed';
  return count <= MAX_SEGMENTED_DURATIONS ? 'segmented' : 'slider';
};
