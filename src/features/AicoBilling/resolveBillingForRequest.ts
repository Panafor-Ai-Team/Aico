import { MANAGED_PROVIDER_IDS, type ManagedProviderId } from '@lobechat/business-const';

import { lambdaClient } from '@/libs/trpc/client';

import {
  getBillingSourcesAllowGateCache,
  seedBillingSourcesAllowGateCache,
} from './billingSourcesAllowGateCache';
import { getAicoBillingContext, setAicoBillingContext } from './store';
import {
  type AicoBillingContext,
  type AicoBillingSourcesResponse,
  findBillingSource,
  getBillingChatBlockReason,
  preferenceToBillingContext,
} from './types';

// Mirrors `AicoManagedPolicy.isManagedProvider` on the server: every gateway we
// mint keys against is managed, so a deployment mid-switch keeps billing context
// attached to requests naming the provider it is moving away from.
const isManagedProvider = (provider: string): boolean =>
  provider === 'aico' || MANAGED_PROVIDER_IDS.includes(provider as ManagedProviderId);

let inFlightBillingSources: Promise<AicoBillingSourcesResponse> | null = null;

/**
 * Cap so a hanging billing RPC fails fast instead of stalling first-token
 * for minutes. The 30s snapshot cache keeps the hot path RPC-free anyway.
 */
// ponytail: fixed 8s cap; raise only if slow networks trigger false timeouts
const ALLOW_GATE_TIMEOUT_MS = 8_000;

const fetchBillingSourcesForAllowGate = async (): Promise<AicoBillingSourcesResponse> => {
  const cached = getBillingSourcesAllowGateCache();
  if (cached) return cached;
  if (inFlightBillingSources) return inFlightBillingSources;

  // Skip upstream remaining/sync — placeHold is the authoritative funds check.
  const request = (
    lambdaClient.aicoBilling.getMyBillingSources.query({
      syncLive: false,
    }) as Promise<AicoBillingSourcesResponse>
  ).then((data) => {
    seedBillingSourcesAllowGateCache(data);
    return data;
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error('Billing allow-gate timed out')),
      ALLOW_GATE_TIMEOUT_MS,
    );
  });

  inFlightBillingSources = Promise.race([request, timeout]).finally(() => {
    clearTimeout(timer);
    inFlightBillingSources = null;
  });

  return inFlightBillingSources;
};

/** Refresh the allow-gate snapshot in the background so the next send skips the RPC. */
export const prewarmAicoBillingAllowGate = (provider: string | undefined): void => {
  if (!provider || !isManagedProvider(provider)) return;
  if (getBillingSourcesAllowGateCache() || inFlightBillingSources) return;

  fetchBillingSourcesForAllowGate().catch(() => {});
};

export const resolveAicoBillingForRequest = async (
  provider: string,
): Promise<AicoBillingContext | undefined> => {
  if (!isManagedProvider(provider)) return undefined;

  const cached = getAicoBillingContext();
  if (cached) return cached;

  const data = await fetchBillingSourcesForAllowGate();
  const context = preferenceToBillingContext(data);
  setAicoBillingContext(context);
  return context;
};

export const assertAicoBillingAllowsChat = async (
  provider: string,
): Promise<AicoBillingContext | undefined> => {
  if (!isManagedProvider(provider)) return undefined;

  const data = await fetchBillingSourcesForAllowGate();

  const cached = getAicoBillingContext();
  const context =
    cached && findBillingSource(data.sources, cached) ? cached : preferenceToBillingContext(data);
  setAicoBillingContext(context);

  const source = findBillingSource(data.sources, context);
  const reason = getBillingChatBlockReason(source, { trialActive: data.trialActive });
  if (reason) {
    throw new Error(reason);
  }

  return context;
};
