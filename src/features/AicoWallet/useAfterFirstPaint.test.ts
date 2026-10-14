import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useAfterFirstPaint } from './useAfterFirstPaint';

describe('useAfterFirstPaint', () => {
  it('is false on first paint, true after the deferred task fires', () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useAfterFirstPaint());
      expect(result.current).toBe(false);

      act(() => {
        vi.runOnlyPendingTimers();
      });
      expect(result.current).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not flip after unmount', () => {
    vi.useFakeTimers();
    try {
      const { result, unmount } = renderHook(() => useAfterFirstPaint());
      unmount();
      act(() => {
        vi.runOnlyPendingTimers();
      });
      expect(result.current).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
