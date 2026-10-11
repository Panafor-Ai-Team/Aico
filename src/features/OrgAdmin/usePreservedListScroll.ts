'use client';

import { type UIEvent, useEffect, useLayoutEffect, useRef } from 'react';

/**
 * Keeps a scrollable list's viewport stable across item reorders.
 *
 * In the team model list, enabling a model moves its row to the top
 * (enabled-first) — without this, that reorder also yanks the viewer to the
 * top. Any other re-render restores the last scroll position before paint;
 * only a `resetKey` change (tab / search / team switch) starts a fresh view
 * at the top.
 */
export const usePreservedListScroll = <T extends HTMLElement = HTMLDivElement>(
  resetKey: string,
) => {
  const listRef = useRef<T>(null);
  const savedScrollTop = useRef(0);

  useEffect(() => {
    savedScrollTop.current = 0;
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [resetKey]);

  // No deps: runs after every render, before paint. No-op when the browser
  // kept the position itself (scrollTop already equals the saved one).
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && savedScrollTop.current > 0 && el.scrollTop !== savedScrollTop.current) {
      el.scrollTop = savedScrollTop.current;
    }
  });

  const onListScroll = (event: UIEvent<T>) => {
    savedScrollTop.current = event.currentTarget.scrollTop;
  };

  return { listRef, onListScroll };
};
