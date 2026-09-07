/**
 * Aico money helpers — integer minor units only.
 * USD is stored as micro-USD (1 USD = 1_000_000 µUSD).
 * Toman is stored as integer Toman.
 * Never use IEEE-754 float arithmetic for balances, reservations, refunds, or FX.
 */

export const MICRO_USD_PER_USD = 1_000_000n;

export type BudgetPeriod = 'total' | 'daily' | 'weekly' | 'monthly';

/** Product-facing org member periods (AICO-140). Legacy `total` is grandfathered only. */
export type ProductBudgetPeriod = 'daily' | 'weekly' | 'monthly';

export const BUDGET_PERIODS: readonly BudgetPeriod[] = [
  'total',
  'daily',
  'weekly',
  'monthly',
] as const;

export const PRODUCT_BUDGET_PERIODS: readonly ProductBudgetPeriod[] = [
  'daily',
  'weekly',
  'monthly',
] as const;

export const isBudgetPeriod = (value: string): value is BudgetPeriod =>
  (BUDGET_PERIODS as readonly string[]).includes(value);

export const isProductBudgetPeriod = (value: string): value is ProductBudgetPeriod =>
  (PRODUCT_BUDGET_PERIODS as readonly string[]).includes(value);

/** OpenRouter Management API `limit_reset` mapping (midnight UTC; weeks Mon–Sun). */
export const periodToOpenRouterLimitReset = (
  period: BudgetPeriod,
): 'daily' | 'weekly' | 'monthly' | null => {
  switch (period) {
    case 'daily': {
      return 'daily';
    }
    case 'weekly': {
      return 'weekly';
    }
    case 'monthly': {
      return 'monthly';
    }
    default: {
      return null;
    }
  }
};

const assertFiniteIntegerString = (raw: string, label: string): bigint => {
  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    throw new Error(`INVALID_MONEY:${label}`);
  }
  return BigInt(trimmed);
};

/** Parse a decimal USD string (e.g. "12.345678") into micro-USD, truncating toward zero. */
export const usdDecimalStringToMicro = (value: string): bigint => {
  const trimmed = value.trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(trimmed)) throw new Error('INVALID_USD_DECIMAL');

  const negative = trimmed.startsWith('-');
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [wholePart, fracPart = ''] = unsigned.split('.');
  const frac = (fracPart + '000000').slice(0, 6);
  const micro = BigInt(wholePart || '0') * MICRO_USD_PER_USD + BigInt(frac || '0');
  return negative ? -micro : micro;
};

/** Format micro-USD as a fixed 6-decimal string for API/tRPC. */
export const microUsdToDecimalString = (micro: bigint | number | string): string => {
  const value =
    typeof micro === 'bigint' ? micro : assertFiniteIntegerString(String(micro), 'micro');
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / MICRO_USD_PER_USD;
  const frac = abs % MICRO_USD_PER_USD;
  const fracStr = frac.toString().padStart(6, '0');
  return `${negative ? '-' : ''}${whole.toString()}.${fracStr}`;
};

/** Convert OpenRouter USD number/limit into micro-USD (floor toward zero — never over-credit). */
export const openRouterUsdToMicroFloor = (usd: number): bigint => {
  if (!Number.isFinite(usd)) throw new Error('INVALID_OR_USD');
  // Capture extra fractional digits then truncate to micro (do not use toFixed(6), which rounds).
  const negative = usd < 0;
  const [wholePart, fracPart = ''] = Math.abs(usd).toFixed(8).split('.');
  const frac = fracPart.slice(0, 6).padEnd(6, '0');
  const micro = BigInt(wholePart || '0') * MICRO_USD_PER_USD + BigInt(frac || '0');
  return negative ? -micro : micro;
};

/**
 * FX: toman → micro-USD using integer math.
 * rate = toman per 1 USD (positive integer or integer string).
 * Floor toward zero so Aico never over-credits.
 */
export const tomanToMicroUsd = (
  amountToman: bigint | number | string,
  tomanPerUsd: bigint | number | string,
): bigint => {
  const toman = typeof amountToman === 'bigint' ? amountToman : BigInt(amountToman);
  const rate = typeof tomanPerUsd === 'bigint' ? tomanPerUsd : BigInt(tomanPerUsd);
  if (toman <= 0n) throw new Error('INVALID_TOMAN_AMOUNT');
  if (rate <= 0n) throw new Error('INVALID_FX_RATE');
  return (toman * MICRO_USD_PER_USD) / rate;
};

/** Inverse of tomanToMicroUsd — floor toward zero. */
export const microUsdToToman = (
  micro: bigint | number | string,
  tomanPerUsd: bigint | number | string,
): bigint => {
  const microValue =
    typeof micro === 'bigint' ? micro : assertFiniteIntegerString(String(micro), 'micro');
  const rate = typeof tomanPerUsd === 'bigint' ? tomanPerUsd : BigInt(tomanPerUsd);
  if (microValue <= 0n) throw new Error('INVALID_MICRO_USD_AMOUNT');
  if (rate <= 0n) throw new Error('INVALID_FX_RATE');
  return (microValue * rate) / MICRO_USD_PER_USD;
};

/** Confirmed unused reservation: never negative; floor already implied by integer subtraction. */
export const confirmedUnusedMicro = (reserved: bigint, authoritativeUsage: bigint): bigint => {
  const unused = reserved - authoritativeUsage;
  return unused > 0n ? unused : 0n;
};

export const assertPositiveMicro = (value: bigint, label = 'amount'): void => {
  if (value <= 0n) throw new Error(`AMOUNT_MUST_BE_POSITIVE:${label}`);
};

export const assertNonNegativeMicro = (value: bigint, label = 'amount'): void => {
  if (value < 0n) throw new Error(`AMOUNT_MUST_BE_NON_NEGATIVE:${label}`);
};

/** JSON-safe money field (decimal string). */
export const moneyString = (micro: bigint | number | string): string =>
  microUsdToDecimalString(micro);

export const tomanString = (toman: bigint | number | string): string => {
  const value = typeof toman === 'bigint' ? toman : BigInt(toman);
  return value.toString();
};

/** Member budget fields needed for current-cycle spend math (FIN-001). */
export type MemberBudgetCycleFields = {
  periodAmountMicroUsd?: number | null;
  reservedMicroUsd?: number | null;
  settledUsageMicroUsd?: number | null;
};

/**
 * Current-cycle spendable cap for a member budget.
 * Pending next-period holds inflate `reservedMicroUsd` but must not raise the
 * live OpenRouter limit until renewal applies them.
 */
export const currentCycleLimitMicroUsd = (budget: MemberBudgetCycleFields): number => {
  const periodAmount = Number(budget.periodAmountMicroUsd ?? 0);
  if (periodAmount > 0) return periodAmount;
  return Number(budget.reservedMicroUsd ?? 0);
};

/** Spendable remaining in the active billing cycle (excludes pending next-period hold). */
export const cycleRemainingMicroUsd = (budget: MemberBudgetCycleFields): number => {
  const limit = currentCycleLimitMicroUsd(budget);
  const settled = Math.max(0, Number(budget.settledUsageMicroUsd ?? 0));
  return Math.max(0, limit - settled);
};

export const isStaleManagedKeyId = (keyId: string | null | undefined): boolean =>
  !keyId || keyId.startsWith('mock_');

export const hasValidManagedKeyId = (keyId: string | null | undefined): boolean =>
  Boolean(keyId) && !isStaleManagedKeyId(keyId);

// ─── Usage multiplier (AICO-180) ───────────────────────────────────────
//
// Aico resells OpenRouter capacity at a platform-wide markup. Everything the
// user sees — prices, per-message cost, wallet balance and remaining — is the
// *billed* figure; OpenRouter's own numbers are *raw* and never leave the
// server. `bp` is the multiplier in basis points (12000 = 1.20x).

/** Default markup applied when no platform config row exists yet. */
export const DEFAULT_USAGE_MULTIPLIER_BP = 12_000;

const MULTIPLIER_BP_SCALE = 10_000;

/** Accepted band for the platform multiplier: 1.00x – 3.00x. */
export const MIN_USAGE_MULTIPLIER_BP = 10_000;
export const MAX_USAGE_MULTIPLIER_BP = 30_000;

export const assertValidMultiplierBp = (bp: number): number => {
  const value = Math.trunc(Number(bp));
  if (
    !Number.isFinite(value) ||
    value < MIN_USAGE_MULTIPLIER_BP ||
    value > MAX_USAGE_MULTIPLIER_BP
  ) {
    throw new Error('INVALID_USAGE_MULTIPLIER');
  }
  return value;
};

/**
 * Normalize an untrusted/stored bp value for *math* (not for validation).
 * Legacy rows and missing config fall back to the default rather than throwing,
 * so a bad row can never wedge billing.
 */
const safeBp = (bp: number | null | undefined): number => {
  const value = Math.trunc(Number(bp ?? DEFAULT_USAGE_MULTIPLIER_BP));
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_USAGE_MULTIPLIER_BP;
  return value;
};

/** Raw OpenRouter micro-USD → billed micro-USD. Ceil: never under-charge. */
export const applyMultiplierMicroUsd = (micro: number, bp: number | null | undefined): number => {
  const value = Math.trunc(Number(micro ?? 0));
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.ceil((value * safeBp(bp)) / MULTIPLIER_BP_SCALE);
};

/** Billed micro-USD → raw micro-USD. Floor: never hand out more headroom than paid for. */
export const removeMultiplierMicroUsd = (micro: number, bp: number | null | undefined): number => {
  const value = Math.trunc(Number(micro ?? 0));
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor((value * MULTIPLIER_BP_SCALE) / safeBp(bp));
};

/**
 * Checkpoint carried on a wallet / member budget so a multiplier change never
 * reprices usage that was already billed at the old rate.
 *
 * `baselineRaw` is OpenRouter's raw usage counter at the moment of the last
 * change; `billedBefore` is what we had already billed by then.
 */
export type UsageMultiplierCheckpoint = {
  billedUsageBeforeBaselineMicroUsd?: number | null;
  checkpointMultiplierBp?: number | null;
  usageBaselineMicroUsd?: number | null;
};

/**
 * Billed usage from OpenRouter's raw counter:
 *   billed = billedBefore + (rawUsage − baselineRaw) x M
 *
 * Usage below the baseline (an OpenRouter-side period reset) contributes
 * nothing rather than going negative.
 */
export const billedUsageFromRaw = (params: {
  baselineRaw: number;
  billedBefore: number;
  bp: number | null | undefined;
  rawUsage: number;
}): number => {
  const baseline = Math.max(0, Math.trunc(Number(params.baselineRaw ?? 0)));
  const billedBefore = Math.max(0, Math.trunc(Number(params.billedBefore ?? 0)));
  const raw = Math.max(0, Math.trunc(Number(params.rawUsage ?? 0)));
  const sinceBaseline = Math.max(0, raw - baseline);
  return billedBefore + applyMultiplierMicroUsd(sinceBaseline, params.bp);
};

/**
 * Inverse of `billedUsageFromRaw`, solved for the raw usage at which the billed
 * amount reaches `balance` — i.e. the OpenRouter key limit:
 *   keyLimit = baselineRaw + (balance − billedBefore) / M
 *
 * An over-spent wallet (billedBefore >= balance) still yields the baseline, so
 * the limit never drops below usage OpenRouter has already recorded.
 */
export const keyLimitFromBilled = (params: {
  balance: number;
  baselineRaw: number;
  billedBefore: number;
  bp: number | null | undefined;
}): number => {
  const baseline = Math.max(0, Math.trunc(Number(params.baselineRaw ?? 0)));
  const billedBefore = Math.max(0, Math.trunc(Number(params.billedBefore ?? 0)));
  const balance = Math.trunc(Number(params.balance ?? 0));
  if (!Number.isFinite(balance) || balance <= 0) return 0;
  const headroom = Math.max(0, balance - billedBefore);
  return baseline + removeMultiplierMicroUsd(headroom, params.bp);
};

/**
 * Roll a checkpoint forward to `nextBp` at the current raw usage, so usage up to
 * now keeps the rate it was billed at and only later usage uses the new rate.
 */
export const rebaseCheckpoint = (params: {
  checkpoint: UsageMultiplierCheckpoint;
  nextBp: number;
  rawUsage: number;
}): { billedUsageBeforeBaselineMicroUsd: number; usageBaselineMicroUsd: number } => {
  const raw = Math.max(0, Math.trunc(Number(params.rawUsage ?? 0)));
  return {
    billedUsageBeforeBaselineMicroUsd: billedUsageFromRaw({
      baselineRaw: Number(params.checkpoint.usageBaselineMicroUsd ?? 0),
      billedBefore: Number(params.checkpoint.billedUsageBeforeBaselineMicroUsd ?? 0),
      bp: params.checkpoint.checkpointMultiplierBp,
      rawUsage: raw,
    }),
    usageBaselineMicroUsd: raw,
  };
};
