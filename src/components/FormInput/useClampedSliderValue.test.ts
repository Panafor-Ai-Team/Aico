import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { clampSliderValue, useClampedSliderValue } from './useClampedSliderValue';

describe('clampSliderValue', () => {
  it('falls back to min instead of 0 when no value is provided', () => {
    expect(clampSliderValue(undefined, 1, 20)).toBe(1);
  });

  it('falls back to 1 when neither value nor min is provided', () => {
    expect(clampSliderValue(undefined)).toBe(1);
  });

  it('clamps a stored value below min up to min', () => {
    expect(clampSliderValue(0, 1, 20)).toBe(1);
  });

  it('clamps a stored value above max down to max', () => {
    expect(clampSliderValue(99, 1, 20)).toBe(20);
  });

  it('keeps an in-range value untouched', () => {
    expect(clampSliderValue(4, 1, 20)).toBe(4);
  });
});

describe('useClampedSliderValue', () => {
  it('starts clamped when the initial value is out of range', () => {
    const { result } = renderHook(() => useClampedSliderValue(0, 1, 20));
    expect(result.current[0]).toBe(1);
  });

  it('re-clamps when the external value updates', () => {
    const { result, rerender } = renderHook(({ value }) => useClampedSliderValue(value, 1, 20), {
      initialProps: { value: 4 as number | undefined },
    });
    expect(result.current[0]).toBe(4);

    rerender({ value: undefined });
    expect(result.current[0]).toBe(1);
  });

  it('clamps writes through the setter', () => {
    const { result } = renderHook(() => useClampedSliderValue(4, 1, 20));
    act(() => {
      result.current[1](0);
    });
    expect(result.current[0]).toBe(1);
  });
});
