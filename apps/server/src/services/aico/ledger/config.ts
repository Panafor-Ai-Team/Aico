import { MANAGED_PROVIDER_ID, type ManagedProviderId } from '@lobechat/business-const';

import { aicoEnv } from '@/envs/aico';

export type LedgerMode = 'enforce' | 'off' | 'shadow';
export type InferenceKeyMode = 'per_subject' | 'shared';

/**
 * Usage ledger settings. Never log this object: `sharedApiKey` is the CVC
 * primary key.
 */
export interface LedgerConfig {
  /**
   * CVC models measured to honour `max_tokens`. Any other model's hold assumes
   * its own output ceiling.
   */
  cappedOutputModels: ReadonlySet<string>;
  defaultMaxOutputTokens: number;
  floatFloorRawMicroUsd: number;
  floatMaxAgeMs: number;
  holdTtlSeconds: number;
  inferenceKey: InferenceKeyMode;
  /**
   * `CHEAPVIBECODE_API_KEY` is set on this process. That variable feeds the
   * unmetered env provider, so shared mode must refuse to run next to it.
   */
  legacyPrimaryKeyExposed: boolean;
  managedProviderId: ManagedProviderId;
  maxOpenHolds: number;
  /** The configured mode, except that shadow on a non-CVC provider is `off`. */
  mode: LedgerMode;
  sharedApiKey: string | null;
}

const parseModelList = (value: string | undefined): ReadonlySet<string> =>
  new Set(
    (value ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
  );

export const getLedgerConfig = (): LedgerConfig => {
  const configured = aicoEnv.AICO_BILLING_LEDGER_MODE;

  return {
    cappedOutputModels: parseModelList(aicoEnv.AICO_LEDGER_CAPPED_OUTPUT_MODELS),
    defaultMaxOutputTokens: aicoEnv.AICO_MANAGED_DEFAULT_MAX_OUTPUT_TOKENS,
    floatFloorRawMicroUsd: aicoEnv.AICO_LEDGER_FLOAT_FLOOR_MICRO_USD,
    floatMaxAgeMs: aicoEnv.AICO_LEDGER_FLOAT_MAX_AGE_SECONDS * 1000,
    holdTtlSeconds: aicoEnv.AICO_LEDGER_HOLD_TTL_SECONDS,
    inferenceKey: aicoEnv.AICO_MANAGED_INFERENCE_KEY,
    legacyPrimaryKeyExposed: Boolean(process.env.CHEAPVIBECODE_API_KEY?.trim()),
    managedProviderId: MANAGED_PROVIDER_ID,
    maxOpenHolds: aicoEnv.AICO_LEDGER_MAX_OPEN_HOLDS,
    // Only CVC is priced by the ledger. Shadow elsewhere measures nothing useful,
    // so it is off; enforce elsewhere is kept so the gate can refuse it loudly.
    mode: MANAGED_PROVIDER_ID === 'cheapvibecode' || configured === 'enforce' ? configured : 'off',
    sharedApiKey: aicoEnv.AICO_SHARED_INFERENCE_API_KEY?.trim() || null,
  };
};

export const isSharedInferenceKey = (): boolean => getLedgerConfig().inferenceKey === 'shared';
