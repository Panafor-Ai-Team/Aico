import {
  billedMicroUsdToPiTokens,
  rawMicroUsdToPiTokens,
  topupPiTokensFromDeposit,
  topupPiTokensPerUsd,
} from '@/database/utils/aicoMoney';
import { aicoEnv } from '@/envs/aico';

/** CVC bridge rate used for every user-facing π figure. */
export const cvcTokensPerUsd = (): number => aicoEnv.AICO_CVC_TOKENS_PER_USD;

export const piPerUsdAtMultiplier = (multiplierBp: number): number =>
  topupPiTokensPerUsd(multiplierBp, cvcTokensPerUsd());

export const piFromRawMicro = (rawMicroUsd: number): number =>
  rawMicroUsdToPiTokens(rawMicroUsd, cvcTokensPerUsd());

export const piFromBilledMicro = (params: {
  balanceMicroUsd?: number | null;
  billedMicroUsd: number;
  fallbackBp?: number | null;
  multiplierBp?: number | null;
  rawCapacityMicroUsd?: number | null;
}): number =>
  billedMicroUsdToPiTokens({
    ...params,
    cvcTokensPerUsd: cvcTokensPerUsd(),
  });

/**
 * `piFromBilledMicro` is 0 for anything at or below zero, so a signed amount is
 * converted on its absolute value and the sign put back.
 */
export const signedPiFromBilledMicro = (params: {
  billedMicroUsd: number;
  multiplierBp?: number | null;
}): number => {
  const billed = Math.trunc(Number(params.billedMicroUsd));
  if (!Number.isFinite(billed)) return 0;
  const abs = piFromBilledMicro({ ...params, billedMicroUsd: Math.abs(billed) });
  return billed < 0 ? -abs : abs;
};

export const piFromDepositMicro = (depositMicroUsd: number, multiplierBp: number): number =>
  topupPiTokensFromDeposit(depositMicroUsd, multiplierBp, cvcTokensPerUsd());
