import type { AicoPersonalBillingSource } from '@/features/AicoBilling';

export interface WalletDisplayInput {
  /** Cumulative deposits from `getMyWallet`. Monotonic — never a credit figure. */
  paidInToman: number | string | null | undefined;
  paidInUsd: number | string | null | undefined;
  personal: AicoPersonalBillingSource | undefined;
}

export interface WalletDisplay {
  paidInToman: string;
  paidInUsd: string;
  /** `null` means "we could not compute it" — render an explicit unknown, not a zero. */
  remainingToman: string | null;
  remainingUsd: string | null;
  /** The remaining figures are a held fallback, not a live reading (FIN-018). */
  stale: boolean;
}

/**
 * What the wallet page is allowed to show, and under which label (FIN-016).
 *
 * `balanceUsd` / `balanceToman` are cumulative deposits: they are monotonic by
 * design and can never decrease, so they may only appear under an explicit
 * "paid in" label. The credit figures come from `remaining` and from nowhere
 * else — the old `personalRemainingUsd ?? wallet.balanceUsd` fallback meant a
 * failed lookup silently redisplayed the deposit as spendable credit, which is
 * indistinguishable from having spent nothing.
 */
export const resolveWalletDisplay = ({
  paidInToman,
  paidInUsd,
  personal,
}: WalletDisplayInput): WalletDisplay => ({
  paidInToman: Number(paidInToman ?? 0).toLocaleString(),
  paidInUsd: `$${Number(paidInUsd ?? 0).toFixed(4)}`,
  remainingToman: personal ? Number(personal.remainingToman ?? 0).toLocaleString() : null,
  remainingUsd: personal ? `$${Number(personal.remainingUsd ?? 0).toFixed(4)}` : null,
  stale: Boolean(personal && !personal.usageKnown),
});
