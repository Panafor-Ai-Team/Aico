import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mutate } from '@/libs/swr';

import { AICO_BILLING_SOURCES_SWR_KEY } from './cacheKeys';
import type { AicoBillingSourcesResponse } from './types';

const getMyBillingSources = vi.fn();

vi.mock('@/libs/swr', () => ({ mutate: vi.fn() }));
vi.mock('@/libs/trpc/client', () => ({
  lambdaClient: {
    aicoBilling: {
      getMyBillingSources: { query: (...args: unknown[]) => getMyBillingSources(...args) },
    },
  },
}));

const sources = (remainingPi: string): AicoBillingSourcesResponse => ({
  preferredBillingSource: 'personal',
  preferredOrganizationId: null,
  sources: [
    {
      hasManagedKey: true,
      isActive: true,
      remainingMicroUsd: '1000000',
      remainingPi,
      remainingToman: '100000',
      remainingUsd: '1.000000',
      source: 'personal',
      usageKnown: remainingPi !== 'held',
    },
  ],
  trialActive: false,
  trialAvailable: false,
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

const load = async () => (await import('./loadBillingSources')).loadBillingSources();

describe('loadBillingSources', () => {
  beforeEach(() => {
    vi.resetModules();
    getMyBillingSources.mockReset();
    vi.mocked(mutate).mockReset().mockResolvedValue(undefined);
  });

  it('returns the held figures without waiting for the live gateway read', async () => {
    const live = deferred<AicoBillingSourcesResponse>();
    getMyBillingSources.mockImplementation(({ syncLive }: { syncLive: boolean }) =>
      syncLive ? live.promise : Promise.resolve(sources('held')),
    );

    await expect(load()).resolves.toEqual(sources('held'));
    expect(getMyBillingSources).toHaveBeenCalledWith({ syncLive: false });
    expect(getMyBillingSources).toHaveBeenCalledWith({ syncLive: true });
    expect(mutate).not.toHaveBeenCalled();
  });

  it('writes the live figures into the cache once the gateway answers', async () => {
    const live = deferred<AicoBillingSourcesResponse>();
    getMyBillingSources.mockImplementation(({ syncLive }: { syncLive: boolean }) =>
      syncLive ? live.promise : Promise.resolve(sources('held')),
    );

    await load();
    live.resolve(sources('42'));

    await vi.waitFor(() =>
      expect(mutate).toHaveBeenCalledWith(AICO_BILLING_SOURCES_SWR_KEY, sources('42'), {
        revalidate: false,
      }),
    );
  });

  it('keeps a single live read in flight across repeated loads', async () => {
    const live = deferred<AicoBillingSourcesResponse>();
    getMyBillingSources.mockImplementation(({ syncLive }: { syncLive: boolean }) =>
      syncLive ? live.promise : Promise.resolve(sources('held')),
    );

    const { loadBillingSources } = await import('./loadBillingSources');
    await loadBillingSources();
    await loadBillingSources();

    const liveCalls = getMyBillingSources.mock.calls.filter(([input]) => input.syncLive);
    expect(liveCalls).toHaveLength(1);
  });

  it('keeps the held figures when the live read fails', async () => {
    getMyBillingSources.mockImplementation(({ syncLive }: { syncLive: boolean }) =>
      syncLive ? Promise.reject(new Error('gateway timeout')) : Promise.resolve(sources('held')),
    );

    await expect(load()).resolves.toEqual(sources('held'));
    await Promise.resolve();
    expect(mutate).not.toHaveBeenCalled();
  });
});
