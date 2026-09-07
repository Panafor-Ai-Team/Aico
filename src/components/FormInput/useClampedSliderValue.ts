import { useEffect, useState } from 'react';

/**
 * Clamp a slider value into [min, max].
 *
 * A missing value falls back to `min` (the AI Art image count starts at 1,
 * never 0), and stored strays outside the range are pulled back in so the
 * slider can neither display nor commit an out-of-range value.
 */
export const clampSliderValue = (next: number | undefined, min?: number, max?: number): number => {
  const fallback = min ?? 1;
  if (typeof next !== 'number' || Number.isNaN(next)) return fallback;
  if (typeof min === 'number' && next < min) return min;
  if (typeof max === 'number' && next > max) return max;
  return next;
};

/**
 * Slider state that stays inside [min, max]: the initial value is clamped,
 * external updates re-clamp, and writes through the setter are clamped too.
 */
export const useClampedSliderValue = (
  defaultValue: number | undefined,
  min?: number,
  max?: number,
) => {
  const [value, setRawValue] = useState(() => clampSliderValue(defaultValue, min, max));

  useEffect(() => {
    setRawValue(clampSliderValue(defaultValue, min, max));
  }, [defaultValue, min, max]);

  return [value, (next: number) => setRawValue(clampSliderValue(next, min, max))] as const;
};
