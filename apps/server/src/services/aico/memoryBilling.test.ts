// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { AicoManagedPolicyError } from './managedPolicy';
import { findMemoryFundsError, isManagedMemoryProvider, isMemoryFundsError } from './memoryBilling';

describe('isMemoryFundsError', () => {
  it.each([
    'PERSONAL_FUNDS_UNAVAILABLE',
    'MEMBER_BUDGET_UNFUNDED',
    'MEMBER_BUDGET_RENEWAL_BLOCKED',
    'PERSONAL_WALLET_INACTIVE:not_found',
    'MANAGED_KEY_UNAVAILABLE',
  ])('treats %s as a funds refusal', (code) => {
    expect(isMemoryFundsError(new AicoManagedPolicyError(code))).toBe(true);
  });

  it.each([
    'MODEL_NOT_ALLOWED',
    'PLATFORM_CAPACITY_EXHAUSTED:ledger_error',
    'BILLING_CONTEXT_REQUIRED',
  ])('does not treat %s as a funds refusal', (code) => {
    expect(isMemoryFundsError(new AicoManagedPolicyError(code))).toBe(false);
  });

  it('ignores plain errors carrying a funds message', () => {
    expect(isMemoryFundsError(new Error('PERSONAL_FUNDS_UNAVAILABLE'))).toBe(false);
  });
});

describe('findMemoryFundsError', () => {
  it('finds a funds refusal swallowed into a layer output', () => {
    const fundsError = new AicoManagedPolicyError('PERSONAL_FUNDS_UNAVAILABLE');

    expect(
      findMemoryFundsError({
        context: { error: new Error('schema mismatch') },
        identity: undefined,
        preference: { error: fundsError },
      }),
    ).toBe(fundsError);
  });

  it('returns undefined when no layer was refused for funds', () => {
    expect(findMemoryFundsError({ context: { error: new Error('boom') } })).toBeUndefined();
    expect(findMemoryFundsError(undefined)).toBeUndefined();
  });
});

describe('isManagedMemoryProvider', () => {
  it('recognizes managed provider ids case-insensitively', () => {
    expect(isManagedMemoryProvider('aico')).toBe(true);
    expect(isManagedMemoryProvider('OpenRouter')).toBe(true);
    expect(isManagedMemoryProvider('cheapvibecode')).toBe(true);
  });

  it('treats BYOK and missing providers as unmanaged', () => {
    expect(isManagedMemoryProvider('openai')).toBe(false);
    expect(isManagedMemoryProvider(undefined)).toBe(false);
  });
});
