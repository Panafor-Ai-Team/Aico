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

export const piFromDepositMicro = (depositMicroUsd: number, multiplierBp: number): number =>
  topupPiTokensFromDeposit(depositMicroUsd, multiplierBp, cvcTokensPerUsd());
