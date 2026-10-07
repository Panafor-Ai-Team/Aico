import type { AicoBillingSource, AicoKeyProvisionError } from '@/features/AicoBilling';

export type SourceKeyMessageKey =
  | 'wallet.keyCapacityExhausted'
  | 'wallet.keyPending'
  | 'wallet.keyProvisionFailed'
  | 'wallet.keyProvisioned';

/**
 * Locale key for the per-source key-status line. A funded source whose key
 * provisioning was attempted and failed says *why* instead of the eternal
 * "key will be created" pending message; a keyless source with nothing
 * funded keeps keyPending (credits really are missing there).
 */
export const resolveSourceKeyMessageKey = (source: AicoBillingSource): SourceKeyMessageKey => {
  if (source.hasManagedKey) return 'wallet.keyProvisioned';
  if (source.source === 'organization') {
    const error: AicoKeyProvisionError | null = source.keyProvisionError ?? null;
    const funded = Number(source.remainingMicroUsd ?? 0) > 0;
    if (error && funded) {
      return error === 'PROVIDER_CAPACITY'
        ? 'wallet.keyCapacityExhausted'
        : 'wallet.keyProvisionFailed';
    }
  }
  return 'wallet.keyPending';
};
