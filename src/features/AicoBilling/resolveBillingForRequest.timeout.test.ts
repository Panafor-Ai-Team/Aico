import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetBillingSourcesAllowGateCacheForTests } from './billingSourcesAllowGateCache';
import {
  assertAicoBillingAllowsChat,
  prewarmAicoBillingAllowGate,
  resolveAicoBillingForRequest,
} from './resolveBillingForRequest';
import { useAicoBillingStore } from './store';

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

describe('billing allow-gate hardening', () => {
  beforeEach(() => {
    useAicoBillingStore.setState({ context: null, hydrated: false });
    resetBillingSourcesAllowGateCacheForTests();
    getMyBillingSources.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('dedupes concurrent allow-gate RPCs', async () => {
    getMyBillingSources.mockResolvedValue(fundedSources);

    const [a, b] = await Promise.all([
      resolveAicoBillingForRequest('openrouter'),
      resolveAicoBillingForRequest('openrouter'),
    ]);

    expect(getMyBillingSources).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
  });

  it('fails fast when the billing RPC hangs, and retries afterwards', async () => {
    // Regression: a hanging billing RPC stalled first-token for minutes.
    vi.useFakeTimers();
    getMyBillingSources.mockReturnValue(new Promise(() => {}));

    // Attach the assertion before advancing: otherwise the rejection lands
    // with no handler yet and vitest reports an unhandled rejection.
    const assertion = expect(assertAicoBillingAllowsChat('openrouter')).rejects.toThrow(
      'Billing allow-gate timed out',
    );
    await vi.advanceTimersByTimeAsync(8_000);
    await assertion;

    // In-flight slot is cleared: the next attempt issues a fresh RPC.
    vi.useRealTimers();
    getMyBillingSources.mockResolvedValue(fundedSources);

    await expect(assertAicoBillingAllowsChat('openrouter')).resolves.toBeDefined();
    expect(getMyBillingSources).toHaveBeenCalledTimes(2);
  });

  it('prewarms the snapshot in the background without duplicating the RPC', async () => {
    getMyBillingSources.mockResolvedValue(fundedSources);

    prewarmAicoBillingAllowGate('openrouter');
    prewarmAicoBillingAllowGate('openrouter');
    prewarmAicoBillingAllowGate('openai');

    await vi.waitFor(() => expect(getMyBillingSources).toHaveBeenCalledTimes(1));
  });
});
