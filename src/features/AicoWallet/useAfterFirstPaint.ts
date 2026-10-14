import { useEffect, useState } from 'react';

/**
 * False on first paint, true right after — lets secondary work (e.g. the
 * wallet transactions fetch) skip the initial request batch without gating
 * first paint on it.
 */
export const useAfterFirstPaint = (): boolean => {
  const [after, setAfter] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setAfter(true), 0);
    return () => clearTimeout(timer);
  }, []);

  return after;
};
