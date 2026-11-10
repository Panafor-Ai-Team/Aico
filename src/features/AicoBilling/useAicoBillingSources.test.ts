import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AICO_BILLING_SOURCES_SWR_KEY } from './cacheKeys';
import { useAicoBillingStore } from './store';
import type { AicoBillingSourcesResponse } from './types';

const setBillingPreference = vi.fn();
const swrMutate = vi.fn();

const data: AicoBillingSourcesResponse = {
  preferredBillingSource: 'personal',
  preferredOrganizationId: null,
  sources: [
    {
      hasManagedKey: true,
      isActive: true,
      remainingMicroUsd: '1000000',
      remainingPi: '20000',
      remainingToman: '100000',
      remainingUsd: '1.000000',
      source: 'personal',
      usageKnown: true,
    },
    {
      budgetAllocated: true,
      hasManagedKey: true,
      isActive: true,
      organizationId: 'org-1',
      organizationName: 'Team',
      remainingMicroUsd: '500000',
      remainingPi: '10000',
      remainingUsd: '0.500000',
      renewalBlocked: false,
      source: 'organization',
    },
  ],
  trialActive: false,
  trialAvailable: false,
};

const swrCalls = vi.hoisted(() => [] as unknown[][]);

vi.mock('@/libs/swr', () => ({
  useClientDataSWR: (...args: unknown[]) => {
    swrCalls.push(args);
    return { data, error: undefined, isLoading: false, mutate: swrMutate };
  },
}));
vi.mock('@/libs/trpc/client', () => ({
  lambdaClient: {
    aicoBilling: {
      setBillingPreference: { mutate: (...args: unknown[]) => setBillingPreference(...args) },
    },
  },
}));
vi.mock('./billingSourcesAllowGateCache', () => ({ seedBillingSourcesAllowGateCache: vi.fn() }));
vi.mock('./loadBillingSources', () => ({ loadBillingSources: vi.fn() }));

const { useAicoBillingSources } = await import('./useAicoBillingSources');

describe('useAicoBillingSources.selectSource', () => {
  beforeEach(() => {
    setBillingPreference.mockReset().mockResolvedValue({});
    swrMutate.mockReset();
    swrCalls.length = 0;
    useAicoBillingStore.setState({ context: { source: 'personal' }, hydrated: true });
  });

  it('dedupes billing-source fetches across rapid remounts', () => {
    renderHook(() => useAicoBillingSources());

    expect(swrCalls[0]?.[0]).toBe(AICO_BILLING_SOURCES_SWR_KEY);
    expect(swrCalls[0]?.[2]).toEqual({ dedupingInterval: 30_000 });
  });

  it('settles once the preference is saved, without waiting for the balance reload', async () => {
    // The reload can wait on the key gateway for many seconds; the switch must not.
    swrMutate.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useAicoBillingSources());

    let settled = false;
    await act(async () => {
      void result.current
        .selectSource({ organizationId: 'org-1', source: 'organization' })
        .then(() => {
          settled = true;
        });
      await vi.waitFor(() => expect(settled).toBe(true));
    });

    expect(useAicoBillingStore.getState().context).toEqual({
      organizationId: 'org-1',
      source: 'organization',
    });
    expect(swrMutate).toHaveBeenCalled();
  });

  it('reverts to the previous source when saving the preference fails', async () => {
    setBillingPreference.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useAicoBillingSources());

    await act(async () => {
      await expect(
        result.current.selectSource({ organizationId: 'org-1', source: 'organization' }),
      ).rejects.toThrow('offline');
    });

    expect(useAicoBillingStore.getState().context).toEqual({ source: 'personal' });
  });
});
