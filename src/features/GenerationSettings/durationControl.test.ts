import { describe, expect, it } from 'vitest';

import { MAX_SEGMENTED_DURATIONS, resolveDurationControl } from './durationControl';

describe('resolveDurationControl', () => {
  it('shows a single length as fixed text', () => {
    expect(resolveDurationControl(1)).toBe('fixed');
  });

  it('uses segment buttons for a short list of lengths', () => {
    expect(resolveDurationControl(2)).toBe('segmented');
    expect(resolveDurationControl(MAX_SEGMENTED_DURATIONS)).toBe('segmented');
  });

  it('uses a slider for a long range instead of a dropdown', () => {
    expect(resolveDurationControl(MAX_SEGMENTED_DURATIONS + 1)).toBe('slider');
    expect(resolveDurationControl(15)).toBe('slider');
  });
});
