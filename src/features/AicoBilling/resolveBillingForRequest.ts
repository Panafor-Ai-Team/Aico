import { MANAGED_PROVIDER_IDS, type ManagedProviderId } from '@lobechat/business-const';

import { lambdaClient } from '@/libs/trpc/client';

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

export const resolveAicoBillingForRequest = async (
  provider: string,
): Promise<AicoBillingContext | undefined> => {
  if (!isManagedProvider(provider)) return undefined;

  const cached = getAicoBillingContext();
  if (cached) return cached;

  const data =
    (await lambdaClient.aicoBilling.getMyBillingSources.query()) as AicoBillingSourcesResponse;
  const context = preferenceToBillingContext(data);
  setAicoBillingContext(context);
  return context;
};

export const assertAicoBillingAllowsChat = async (
  provider: string,
): Promise<AicoBillingContext | undefined> => {
  if (!isManagedProvider(provider)) return undefined;

  const data =
    (await lambdaClient.aicoBilling.getMyBillingSources.query()) as AicoBillingSourcesResponse;

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
