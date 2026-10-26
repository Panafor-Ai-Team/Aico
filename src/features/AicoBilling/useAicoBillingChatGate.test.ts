import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useAicoBillingChatGate } from './useAicoBillingChatGate';

const useAicoBillingSources = vi.fn();

vi.mock('./useAicoBillingSources', () => ({
  useAicoBillingSources: () => useAicoBillingSources(),
}));

describe('useAicoBillingChatGate', () => {
  beforeEach(() => {
    useAicoBillingSources.mockReset();
  });

  it('fail-closed while billing sources are loading', () => {
    useAicoBillingSources.mockReturnValue({
      activeSource: undefined,
      data: undefined,
      isLoading: true,
    });

    const { result } = renderHook(() => useAicoBillingChatGate());
    expect(result.current.blocked).toBe(true);
    expect(result.current.blockReason).toBeNull();
  });

  it('reports loading (not just blocked) while billing sources are loading', () => {
    useAicoBillingSources.mockReturnValue({
      activeSource: undefined,
      data: undefined,
      isLoading: true,
    });

    const { result } = renderHook(() => useAicoBillingChatGate());
    expect(result.current.loading).toBe(true);
  });

  it('is blocked but not loading once the load failed', () => {
    useAicoBillingSources.mockReturnValue({
      activeSource: undefined,
      data: undefined,
      error: new Error('boom'),
      isLoading: false,
    });

    const { result } = renderHook(() => useAicoBillingChatGate());
    expect(result.current.blocked).toBe(true);
    expect(result.current.loading).toBe(false);
  });

  it('fail-closed when active source is not resolved yet', () => {
    useAicoBillingSources.mockReturnValue({
      activeSource: undefined,
      data: { sources: [], trialActive: false, trialAvailable: false },
      isLoading: false,
    });

    const { result } = renderHook(() => useAicoBillingChatGate());
    expect(result.current.blocked).toBe(true);
  });
});
