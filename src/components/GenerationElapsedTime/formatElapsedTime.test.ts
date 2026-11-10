import { describe, expect, it } from 'vitest';

import { formatGenerationElapsedTime } from './formatElapsedTime';

describe('formatGenerationElapsedTime', () => {
  it('shows seconds with one decimal under a minute', () => {
    expect(formatGenerationElapsedTime(0)).toBe('0.0s');
    expect(formatGenerationElapsedTime(12_345)).toBe('12.3s');
    expect(formatGenerationElapsedTime(59_949)).toBe('59.9s');
  });

  it('shows whole minutes and seconds from one minute, matching the tool-row timer', () => {
    expect(formatGenerationElapsedTime(60_000)).toBe('1min0s');
    expect(formatGenerationElapsedTime(65_900)).toBe('1min5s');
    expect(formatGenerationElapsedTime(125_000)).toBe('2min5s');
  });

  it('clamps negative durations (clock skew) to zero', () => {
    expect(formatGenerationElapsedTime(-500)).toBe('0.0s');
  });
});
