'use client';

import { getCvcTokensPerUsd, setCvcTokensPerUsd } from './piToken';
import { useAicoBillingSources } from './useAicoBillingSources';

/**
 * CVC tokens per USD from the server, for components that show multipliers.
 * Subscribing re-renders the caller when the billing sources land, so a
 * coefficient is never formatted with a stale rate for longer than that load.
 */
export const useCvcTokensPerUsd = (): number => {
  const { data } = useAicoBillingSources();
  if (data?.cvcTokensPerUsd) setCvcTokensPerUsd(data.cvcTokensPerUsd);
  return getCvcTokensPerUsd();
};
