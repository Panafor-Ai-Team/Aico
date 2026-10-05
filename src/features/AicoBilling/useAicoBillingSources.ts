'use client';

import { useCallback, useEffect } from 'react';

import { useClientDataSWR } from '@/libs/swr';
import { lambdaClient } from '@/libs/trpc/client';

import { seedBillingSourcesAllowGateCache } from './billingSourcesAllowGateCache';
import { AICO_BILLING_SOURCES_SWR_KEY } from './cacheKeys';
import { loadBillingSources } from './loadBillingSources';
import { useAicoBillingStore } from './store';
import {
  type AicoBillingContext,
  type AicoBillingSourcesResponse,
  findBillingSource,
  isSameBillingContext,
  preferenceToBillingContext,
} from './types';

export const useAicoBillingSources = () => {
  const context = useAicoBillingStore((s) => s.context);
  const setContext = useAicoBillingStore((s) => s.setContext);

  const { data, error, isLoading, mutate } = useClientDataSWR<AicoBillingSourcesResponse>(
    AICO_BILLING_SOURCES_SWR_KEY,
    loadBillingSources,
  );

  useEffect(() => {
    if (!data) return;
    // Wallet / SWR live reads warm the chat allow-gate so the next send skips RPC.
    seedBillingSourcesAllowGateCache(data);
    const preferred = preferenceToBillingContext(data);
    const current = useAicoBillingStore.getState().context;
    if (!current || !findBillingSource(data.sources, current)) {
      setContext(preferred);
    }
  }, [data, setContext]);

  const selectSource = useCallback(
    async (next: AicoBillingContext) => {
      const previous = useAicoBillingStore.getState().context;
      setContext(next);

      try {
        await lambdaClient.aicoBilling.setBillingPreference.mutate(
          next.source === 'personal'
            ? { source: 'personal' }
            : { organizationId: next.organizationId, source: 'organization' },
        );
      } catch (err) {
        if (previous) setContext(previous);
        throw err;
      }
      void mutate();
    },
    [mutate, setContext],
  );

  const activeSource = data && context ? findBillingSource(data.sources, context) : undefined;
  const canSwitch = (data?.sources.length ?? 0) > 1;

  return {
    activeContext: context,
    activeSource,
    canSwitch,
    data,
    error,
    isLoading,
    isSelected: (candidate: AicoBillingContext) =>
      context ? isSameBillingContext(context, candidate) : false,
    mutate,
    selectSource,
  };
};
