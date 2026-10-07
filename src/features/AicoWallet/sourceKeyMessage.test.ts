import { describe, expect, it } from 'vitest';

import type { AicoBillingSource } from '@/features/AicoBilling';

import { resolveSourceKeyMessageKey } from './sourceKeyMessage';

const orgBase = {
  budgetAllocated: true,
  hasManagedKey: false,
  isActive: true,
  organizationId: 'org-1',
  organizationName: 'Acme',
  remainingMicroUsd: '50000000',
  remainingPi: '1000000',
  remainingUsd: '50.000000',
  renewalBlocked: false,
  source: 'organization',
} as const;

const personalBase = {
  hasManagedKey: false,
  isActive: true,
  remainingMicroUsd: '0',
  remainingPi: '0',
  remainingToman: '0',
  remainingUsd: '0.000000',
  source: 'personal',
  usageKnown: true,
} as const;

describe('resolveSourceKeyMessageKey', () => {
  it('shows provisioned when the source has a key', () => {
    const source: AicoBillingSource = { ...orgBase, hasManagedKey: true };
    expect(resolveSourceKeyMessageKey(source)).toBe('wallet.keyProvisioned');
  });

  it('keeps pending when no key and no provision error', () => {
    expect(resolveSourceKeyMessageKey({ ...orgBase })).toBe('wallet.keyPending');
  });

  it('names capacity exhaustion for a funded source without a key', () => {
    const source: AicoBillingSource = { ...orgBase, keyProvisionError: 'PROVIDER_CAPACITY' };
    expect(resolveSourceKeyMessageKey(source)).toBe('wallet.keyCapacityExhausted');
  });

  it('names a failed provision for a funded source without a key', () => {
    const source: AicoBillingSource = { ...orgBase, keyProvisionError: 'PROVIDER_UNAVAILABLE' };
    expect(resolveSourceKeyMessageKey(source)).toBe('wallet.keyProvisionFailed');
  });

  it('keeps pending when the failed source has nothing funded', () => {
    const source: AicoBillingSource = {
      ...orgBase,
      keyProvisionError: 'PROVIDER_UNAVAILABLE',
      remainingMicroUsd: '0',
    };
    expect(resolveSourceKeyMessageKey(source)).toBe('wallet.keyPending');
  });

  it('keeps pending for a keyless personal source', () => {
    expect(resolveSourceKeyMessageKey({ ...personalBase })).toBe('wallet.keyPending');
  });
});
