import type { AicoBillingSourcesResponse } from './types';

/** How long chat may reuse a billing-sources snapshot without another RPC. */
export const BILLING_SOURCES_ALLOW_GATE_TTL_MS = 30_000;

let cached: { data: AicoBillingSourcesResponse; fetchedAt: number } | null = null;

export const getBillingSourcesAllowGateCache = (): AicoBillingSourcesResponse | null => {
  if (!cached) return null;
  if (Date.now() - cached.fetchedAt >= BILLING_SOURCES_ALLOW_GATE_TTL_MS) return null;
  return cached.data;
};

/** Seed / refresh the allow-gate snapshot (wallet load, optimistic debit, live fetch). */
export const seedBillingSourcesAllowGateCache = (data: AicoBillingSourcesResponse): void => {
  cached = { data, fetchedAt: Date.now() };
};

export const invalidateBillingSourcesAllowGateCache = (): void => {
  cached = null;
};

/** Test helper — clears TTL state between cases. */
export const resetBillingSourcesAllowGateCacheForTests = (): void => {
  cached = null;
};
