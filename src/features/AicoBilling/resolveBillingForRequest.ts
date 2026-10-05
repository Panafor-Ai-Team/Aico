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

const fetchBillingSourcesForAllowGate = async (): Promise<AicoBillingSourcesResponse> => {
  const cached = getBillingSourcesAllowGateCache();
  if (cached) return cached;
  if (inFlightBillingSources) return inFlightBillingSources;

  // Skip upstream remaining/sync — placeHold is the authoritative funds check.
  inFlightBillingSources = (
    lambdaClient.aicoBilling.getMyBillingSources.query({
      syncLive: false,
    }) as Promise<AicoBillingSourcesResponse>
  )
    .then((data) => {
      seedBillingSourcesAllowGateCache(data);
      return data;
    })
    .finally(() => {
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
