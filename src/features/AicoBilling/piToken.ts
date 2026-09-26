/**
 * Client-side π token formatting (1 π = 1000 CVC tokens).
 * Prefer server-provided `remainingPi` / `piPerUsd` when available; these
 * helpers cover message costs and model rates that still arrive as raw USD.
 */

export const CVC_TOKENS_PER_PI = 1000;
export const DEFAULT_CVC_TOKENS_PER_USD = 25_000_000;
/** Default top-up yield at CVC 1.25×: $1 → 20_000 π. */
export const DEFAULT_PI_PER_USD = 20_000;

export const rawUsdToPiTokens = (
  rawUsd: number,
  cvcTokensPerUsd: number = DEFAULT_CVC_TOKENS_PER_USD,
): number => {
  if (!Number.isFinite(rawUsd) || rawUsd <= 0) return 0;
  return (rawUsd * cvcTokensPerUsd) / CVC_TOKENS_PER_PI;
};

/** Format a π amount for UI (balances are integers; tiny costs keep decimals). */
export const formatPiTokens = (pi: number | string | null | undefined): string => {
  const n = typeof pi === 'string' ? Number(pi) : Number(pi ?? 0);
  if (!Number.isFinite(n)) return '0 π';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 100) return `${sign}${Math.round(abs).toLocaleString()} π`;
  if (abs >= 1) return `${sign}${abs.toFixed(2)} π`;
  if (abs === 0) return '0 π';
  return `${sign}${abs.toFixed(3)} π`;
};

export const formatRemainingPi = (remainingPi: string | number | undefined): string =>
  formatPiTokens(remainingPi ?? 0);

/** Convert π → billed USD string for APIs that still take amountUsd. */
export const piTokensToBilledUsdString = (
  pi: number,
  piPerUsd: number = DEFAULT_PI_PER_USD,
): string => {
  if (!Number.isFinite(pi) || pi <= 0 || !Number.isFinite(piPerUsd) || piPerUsd <= 0) {
    return '0.000000';
  }
  return (pi / piPerUsd).toFixed(6);
};
