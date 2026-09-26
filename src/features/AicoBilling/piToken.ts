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

/**
 * CVC usage coefficient for a catalog USD rate.
 * At default 25M CVC/$: 1× ≈ $0.04/M tokens ≈ 1,000 π/M tokens.
 */
export const rawUsdToCvcCoefficient = (
  rawUsd: number,
  cvcTokensPerUsd: number = DEFAULT_CVC_TOKENS_PER_USD,
): number => {
  if (!Number.isFinite(rawUsd) || rawUsd <= 0) return 0;
  return (rawUsd * cvcTokensPerUsd) / 1_000_000;
};

/** Format a CVC coefficient for UI (`4×`, `0.33×`, `62.5×`). */
export const formatCvcCoefficient = (coefficient: number): string => {
  if (!Number.isFinite(coefficient) || coefficient === 0) return '0×';
  // One decimal from 10× up (keeps 62.5× / 312.5×); two decimals below 10×.
  const rounded =
    coefficient >= 10 ? Math.round(coefficient * 10) / 10 : Math.round(coefficient * 100) / 100;
  const text = Number.isInteger(rounded) ? String(rounded) : String(parseFloat(rounded.toFixed(2)));
  return `${text}×`;
};

/** Format a π amount number (no unit) for rate rows. */
export const formatPiRateAmount = (pi: number): string => {
  if (!Number.isFinite(pi) || pi === 0) return '0';
  if (pi >= 100) return Math.round(pi).toLocaleString();
  if (pi >= 1) return pi.toFixed(2);
  return pi.toFixed(3);
};

/**
 * Hybrid token rate for managed catalogs: coefficient primary, π secondary.
 * Example: `$0.16/M` → `4× · 4,000` (caller appends ` π/M tokens`).
 */
export const formatHybridPiRate = (
  rawUsd: number,
  cvcTokensPerUsd: number = DEFAULT_CVC_TOKENS_PER_USD,
): string => {
  const coefficient = formatCvcCoefficient(rawUsdToCvcCoefficient(rawUsd, cvcTokensPerUsd));
  const pi = formatPiRateAmount(rawUsdToPiTokens(rawUsd, cvcTokensPerUsd));
  return `${coefficient} · ${pi}`;
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
