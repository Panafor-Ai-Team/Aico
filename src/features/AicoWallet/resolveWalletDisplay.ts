import type { AicoPersonalBillingSource } from '@/features/AicoBilling';
import { formatPiTokens } from '@/features/AicoBilling/piToken';

export interface WalletDisplayInput {
  /** Cumulative π from raw capacity (`getMyWallet.paidInPi`). */
  paidInPi: number | string | null | undefined;
  personal: AicoPersonalBillingSource | undefined;
}

export interface WalletDisplay {
  paidInPi: string;
  /** `null` means "we could not compute it" — render an explicit unknown, not a zero. */
  remainingPi: string | null;
  /** The remaining figures are a held fallback, not a live reading (FIN-018). */
  stale: boolean;
}

/**
 * What the wallet page is allowed to show (π tokens).
 *
 * Paid-in π comes from cumulative raw capacity. Remaining π comes only from
 * `personal.remainingPi` — never fall back to the deposit total.
 */
export const resolveWalletDisplay = ({
  paidInPi,
  personal,
}: WalletDisplayInput): WalletDisplay => ({
  paidInPi: formatPiTokens(paidInPi ?? 0),
  remainingPi: personal ? formatPiTokens(personal.remainingPi ?? 0) : null,
  stale: Boolean(personal && !personal.usageKnown),
});
