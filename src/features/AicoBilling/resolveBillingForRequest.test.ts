import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetBillingSourcesAllowGateCacheForTests } from './billingSourcesAllowGateCache';
import {
  assertAicoBillingAllowsChat,
  resolveAicoBillingForRequest,
} from './resolveBillingForRequest';
import { setAicoBillingContext, useAicoBillingStore } from './store';

const getMyBillingSources = vi.fn();

vi.mock('@/libs/trpc/client', () => ({
  lambdaClient: {
    aicoBilling: {
      getMyBillingSources: { query: (...args: unknown[]) => getMyBillingSources(...args) },
    },
  },
}));

const fundedSources = {
  preferredBillingSource: 'organization' as const,
  preferredOrganizationId: 'org-9',
  sources: [
    {
      hasManagedKey: true,
      isActive: true,
      remainingMicroUsd: '0',
      remainingPi: '0',
      remainingToman: '0',
      remainingUsd: '0.000000',
      source: 'personal' as const,
      usageKnown: true,
    },
    {
      budgetAllocated: true,
      hasManagedKey: true,
      isActive: true,
      organizationId: 'org-9',
      organizationName: 'Nine',
      remainingMicroUsd: '1000000',
      remainingPi: '20000',
      remainingUsd: '1.000000',
      renewalBlocked: false,
      source: 'organization' as const,
    },
  ],
  trialActive: false,
  trialAvailable: false,
};

describe('resolveAicoBillingForRequest', () => {
  beforeEach(() => {
    useAicoBillingStore.setState({ context: null, hydrated: false });
    resetBillingSourcesAllowGateCacheForTests();
    getMyBillingSources.mockReset();
  });

  it('skips non-managed providers', async () => {
    await expect(resolveAicoBillingForRequest('openai')).resolves.toBeUndefined();
    expect(getMyBillingSources).not.toHaveBeenCalled();
  });

  it('returns cached context for aico/openrouter without refetch', async () => {
    setAicoBillingContext({ source: 'personal' });
    await expect(resolveAicoBillingForRequest('aico')).resolves.toEqual({ source: 'personal' });
    await expect(resolveAicoBillingForRequest('openrouter')).resolves.toEqual({
      source: 'personal',
    });
    expect(getMyBillingSources).not.toHaveBeenCalled();
  });

  it('loads preference when cache is empty via syncLive:false', async () => {
    getMyBillingSources.mockResolvedValue(fundedSources);

    await expect(resolveAicoBillingForRequest('aico')).resolves.toEqual({
      organizationId: 'org-9',
      source: 'organization',
    });
    expect(getMyBillingSources).toHaveBeenCalledWith({ syncLive: false });
    expect(useAicoBillingStore.getState().context).toEqual({
      organizationId: 'org-9',
      source: 'organization',
    });
  });
});

describe('assertAicoBillingAllowsChat', () => {
  beforeEach(() => {
    useAicoBillingStore.setState({ context: null, hydrated: false });
    resetBillingSourcesAllowGateCacheForTests();
    getMyBillingSources.mockReset();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('skips non-managed providers', async () => {
    await expect(assertAicoBillingAllowsChat('openai')).resolves.toBeUndefined();
    expect(getMyBillingSources).not.toHaveBeenCalled();
  });

  it('allows funded selected org source without live upstream sync', async () => {
    setAicoBillingContext({ organizationId: 'org-9', source: 'organization' });
    getMyBillingSources.mockResolvedValue(fundedSources);

    await expect(assertAicoBillingAllowsChat('aico')).resolves.toEqual({
      organizationId: 'org-9',
      source: 'organization',
    });
    expect(getMyBillingSources).toHaveBeenCalledWith({ syncLive: false });
  });

  it('reuses allow-gate cache within TTL so consecutive sends skip RPC', async () => {
    setAicoBillingContext({ organizationId: 'org-9', source: 'organization' });
    getMyBillingSources.mockResolvedValue(fundedSources);

    await assertAicoBillingAllowsChat('aico');
    await assertAicoBillingAllowsChat('aico');

    expect(getMyBillingSources).toHaveBeenCalledTimes(1);
  });

  it('refetches after the allow-gate TTL expires', async () => {
    vi.useFakeTimers();
    setAicoBillingContext({ organizationId: 'org-9', source: 'organization' });
    getMyBillingSources.mockResolvedValue(fundedSources);

    await assertAicoBillingAllowsChat('aico');
    await vi.advanceTimersByTimeAsync(30_000);
    await assertAicoBillingAllowsChat('aico');

    expect(getMyBillingSources).toHaveBeenCalledTimes(2);
  });

  it('throws PERSONAL_FUNDS_UNAVAILABLE for empty personal without trial', async () => {
    setAicoBillingContext({ source: 'personal' });
    getMyBillingSources.mockResolvedValue(fundedSources);

    await expect(assertAicoBillingAllowsChat('aico')).rejects.toThrow('PERSONAL_FUNDS_UNAVAILABLE');
  });

  it('allows empty personal when trial is active', async () => {
    setAicoBillingContext({ source: 'personal' });
    getMyBillingSources.mockResolvedValue({
      ...fundedSources,
      trialActive: true,
    });

    await expect(assertAicoBillingAllowsChat('aico')).resolves.toEqual({ source: 'personal' });
  });
});
