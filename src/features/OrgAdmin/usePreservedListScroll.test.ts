import { renderHook } from '@testing-library/react';
import type { UIEvent } from 'react';
import { describe, expect, it } from 'vitest';

import { usePreservedListScroll } from './usePreservedListScroll';

const scrollTo = (
  onListScroll: (event: UIEvent<HTMLDivElement>) => void,
  el: HTMLDivElement,
  top: number,
) => {
  el.scrollTop = top;
  onListScroll({ currentTarget: el } as unknown as UIEvent<HTMLDivElement>);
};

describe('usePreservedListScroll', () => {
  it('restores the scroll position when a reorder resets it', () => {
    const el = document.createElement('div');
    const { result, rerender } = renderHook(({ resetKey }) => usePreservedListScroll(resetKey), {
      initialProps: { resetKey: 'tab' },
    });
    result.current.listRef.current = el;

    scrollTo(result.current.onListScroll, el, 40);
    // Simulate the browser dropping scrollTop on a reorder render.
    el.scrollTop = 0;
    rerender({ resetKey: 'tab' });
    expect(el.scrollTop).toBe(40);
  });

  it('leaves the scroll position alone when nothing reset it', () => {
    const el = document.createElement('div');
    const { result, rerender } = renderHook(({ resetKey }) => usePreservedListScroll(resetKey), {
      initialProps: { resetKey: 'tab' },
    });
    result.current.listRef.current = el;

    scrollTo(result.current.onListScroll, el, 40);
    rerender({ resetKey: 'tab' });
    expect(el.scrollTop).toBe(40);
  });

  it('scrolls back to the top on a fresh view (tab / search / team change)', () => {
    const el = document.createElement('div');
    const { result, rerender } = renderHook(({ resetKey }) => usePreservedListScroll(resetKey), {
      initialProps: { resetKey: 'tab-a' },
    });
    result.current.listRef.current = el;

    scrollTo(result.current.onListScroll, el, 40);
    rerender({ resetKey: 'tab-b' });
    expect(el.scrollTop).toBe(0);
  });
});
