import { mutate } from '@/libs/swr';
import { lambdaClient } from '@/libs/trpc/client';

import { AICO_BILLING_SOURCES_SWR_KEY } from './cacheKeys';
import type { AicoBillingSourcesResponse } from './types';

const queryBillingSources = (syncLive: boolean) =>
  lambdaClient.aicoBilling.getMyBillingSources.query({
    syncLive,
  }) as Promise<AicoBillingSourcesResponse>;

let liveRefresh: Promise<void> | null = null;

const refreshLiveBillingSources = () => {
  if (liveRefresh) return;
  liveRefresh = queryBillingSources(true)
    .then(async (live) => {
      await mutate(AICO_BILLING_SOURCES_SWR_KEY, live, { revalidate: false });
    })
    .catch(() => {})
    .finally(() => {
      liveRefresh = null;
    });
};

/**
 * Held figures come straight from the database; the live read waits on the key
 * gateway (up to two request timeouts when it is unreachable), so it must never
 * gate the wallet's first paint or a source switch. It lands in the cache when
 * it returns.
 */
export const loadBillingSources = async (): Promise<AicoBillingSourcesResponse> => {
  const held = await queryBillingSources(false);
  refreshLiveBillingSources();
  return held;
};
