import { describe, expect, it } from 'vitest';

import {
  applyMultiplierMicroUsd,
  assertValidModelMultiplierBp,
  assertValidMultiplierBp,
  billedMicroUsdToPiTokens,
  billedUsageFromCapacity,
  billedUsageFromRaw,
  blendedMultiplierBp,
  defaultMultiplierBpForProvider,
  keyLimitFromBilled,
  piTokensToRawMicroUsd,
  rawCapacityFromDeposit,
  rawMicroUsdToPiTokens,
  rawUsageFromRemaining,
  rawUsdToPiTokensDecimal,
  rebaseCheckpoint,
  removeMultiplierMicroUsd,
  rotateCheckpointToNewKey,
  topupPiTokensFromDeposit,
  topupPiTokensPerUsd,
  type UsageMultiplierCheckpoint,
} from './aicoMoney';

const USD = 1_000_000;

describe('applyMultiplierMicroUsd / removeMultiplierMicroUsd', () => {
  it('marks raw usage up and divides a billed balance back down', () => {
    expect(applyMultiplierMicroUsd(10 * USD, 12_000)).toBe(12 * USD);
    expect(removeMultiplierMicroUsd(12 * USD, 12_000)).toBe(10 * USD);
  });

  it('rounds markup up and headroom down so the platform never under-charges', () => {
    expect(applyMultiplierMicroUsd(1, 12_000)).toBe(2); // ceil(1.2)
    expect(removeMultiplierMicroUsd(1, 12_000)).toBe(0); // floor(0.83)
  });

  it('is the identity at 1.0x and for unusable multipliers', () => {
    expect(applyMultiplierMicroUsd(7 * USD, 10_000)).toBe(7 * USD);
    // An unreadable multiplier must not silently bill at 1.0x.
    expect(applyMultiplierMicroUsd(10 * USD, 0)).toBe(12 * USD);
    expect(applyMultiplierMicroUsd(10 * USD, null)).toBe(12 * USD);
  });

  it('rejects out-of-band multipliers', () => {
    expect(assertValidMultiplierBp(15_000)).toBe(15_000);
    expect(() => assertValidMultiplierBp(9_999)).toThrow('INVALID_USAGE_MULTIPLIER');
    expect(() => assertValidMultiplierBp(30_001)).toThrow('INVALID_USAGE_MULTIPLIER');
  });

  // CheapVibeCode sells 25M tokens per USD. Crediting a $1 top-up with 20M of
  // them means buying $0.80 of raw capacity, i.e. a 1.25x markup. If this pair
  // ever inverts, every CVC wallet is mispriced.
  it('prices the CheapVibeCode rate at 1.25x in both directions', () => {
    expect(applyMultiplierMicroUsd(80 * USD, 12_500)).toBe(100 * USD);
    expect(removeMultiplierMicroUsd(100 * USD, 12_500)).toBe(80 * USD);
    expect(rawCapacityFromDeposit(1 * USD, 12_500)).toBe(800_000);
  });
});

describe('billing identity', () => {
  const fresh = { baselineRaw: 0, billedBefore: 0, bp: 12_000 };

  it('sells a $12 wallet $10 of raw upstream spend at 1.2x', () => {
    expect(keyLimitFromBilled({ ...fresh, balance: 12 * USD })).toBe(10 * USD);
  });

  it('bills raw usage at the multiplier', () => {
    expect(billedUsageFromRaw({ ...fresh, rawUsage: 5 * USD })).toBe(6 * USD);
  });

  it('never hands out headroom below usage OpenRouter already recorded', () => {
    // Wallet fully spent: limit collapses to the checkpoint baseline, not below.
    expect(
      keyLimitFromBilled({
        balance: 6 * USD,
        baselineRaw: 5 * USD,
        billedBefore: 6 * USD,
        bp: 12_000,
      }),
    ).toBe(5 * USD);
  });

  it('treats usage below the baseline as an upstream reset, not negative usage', () => {
    expect(
      billedUsageFromRaw({ baselineRaw: 5 * USD, billedBefore: 6 * USD, bp: 12_000, rawUsage: 0 }),
    ).toBe(6 * USD);
  });
});

describe('a multiplier change does not reprice past usage (AICO-180 regression)', () => {
  it('keeps earlier usage at the old rate and bills only later usage at the new one', () => {
    const balance = 12 * USD;

    // $5 of raw spend at 1.2x -> $6 billed.
    let checkpoint: UsageMultiplierCheckpoint = {
      billedUsageBeforeBaselineMicroUsd: 0,
      checkpointMultiplierBp: 12_000,
      usageBaselineMicroUsd: 0,
    };
    const rawAtChange = 5 * USD;
    expect(
      billedUsageFromRaw({
        baselineRaw: Number(checkpoint.usageBaselineMicroUsd),
        billedBefore: Number(checkpoint.billedUsageBeforeBaselineMicroUsd),
        bp: checkpoint.checkpointMultiplierBp,
        rawUsage: rawAtChange,
      }),
    ).toBe(6 * USD);

    // Super admin raises the multiplier to 1.5x.
    checkpoint = {
      ...rebaseCheckpoint({ checkpoint, nextBp: 15_000, rawUsage: rawAtChange }),
      checkpointMultiplierBp: 15_000,
    };
    expect(checkpoint.billedUsageBeforeBaselineMicroUsd).toBe(6 * USD);

    // Another $2 of raw spend, now at 1.5x -> $3, for $9 billed in total.
    // Repricing the first $5 at 1.5x would have produced $10.50.
    const billed = billedUsageFromRaw({
      baselineRaw: Number(checkpoint.usageBaselineMicroUsd),
      billedBefore: Number(checkpoint.billedUsageBeforeBaselineMicroUsd),
      bp: checkpoint.checkpointMultiplierBp,
      rawUsage: rawAtChange + 2 * USD,
    });
    expect(billed).toBe(9 * USD);
    expect(balance - billed).toBe(3 * USD);

    // The re-pushed key limit lets the remaining $3 of balance buy $2 of raw
    // spend at the new rate, on top of the $5 already recorded upstream.
    expect(
      keyLimitFromBilled({
        balance,
        baselineRaw: Number(checkpoint.usageBaselineMicroUsd),
        billedBefore: Number(checkpoint.billedUsageBeforeBaselineMicroUsd),
        bp: checkpoint.checkpointMultiplierBp,
      }),
    ).toBe(9 * USD);
  });
});

describe('a multiplier change does not revalue money already paid (AICO-184 regression)', () => {
  it('gives each top-up the rate that was in force when it was paid', () => {
    // $1.20 at 1.2x, then the platform moves to 1.5x, then $1.50 at 1.5x.
    const capacity =
      rawCapacityFromDeposit(1_200_000, 12_000) + rawCapacityFromDeposit(1_500_000, 15_000);

    // Each purchase bought a dollar of upstream spend and keeps it.
    expect(capacity).toBe(2_000_000);

    // What AICO-180 did instead: divide the whole $2.70 by the current rate,
    // silently revaluing the first top-up down to $0.80.
    expect(removeMultiplierMicroUsd(2_700_000, 15_000)).toBe(1_800_000);
  });

  it('bills usage at the blend of the rates actually bought at', () => {
    const balanceMicroUsd = 2_700_000;
    const rawCapacityMicroUsd = 2_000_000;

    expect(blendedMultiplierBp({ balanceMicroUsd, fallbackBp: 15_000, rawCapacityMicroUsd })).toBe(
      13_500,
    );

    const billed = (rawUsageMicroUsd: number) =>
      billedUsageFromCapacity({
        balanceMicroUsd,
        fallbackBp: 15_000,
        rawCapacityMicroUsd,
        rawUsageMicroUsd,
      });

    expect(billed(0)).toBe(0);
    expect(billed(1_000_000)).toBe(1_350_000);
    // Spending the capacity bills the balance exactly — no rounding drift.
    expect(billed(2_000_000)).toBe(2_700_000);
    expect(billed(2_500_000)).toBe(2_700_000);
  });

  it('lowering the multiplier does not inflate capacity either', () => {
    // Paid $1.50 at 1.5x; the platform then drops to 1.2x.
    const capacity = rawCapacityFromDeposit(1_500_000, 15_000);
    expect(capacity).toBe(1_000_000);
    // AICO-180 would have handed out $1.25 of spend for the same $1.50.
    expect(removeMultiplierMicroUsd(1_500_000, 12_000)).toBe(1_250_000);
  });

  it('falls back to the platform rate for a wallet that has bought nothing', () => {
    // A trial funds the key without crediting the wallet — usage must still be
    // billed rather than shown as free.
    expect(
      billedUsageFromCapacity({
        balanceMicroUsd: 0,
        fallbackBp: 12_000,
        rawCapacityMicroUsd: 0,
        rawUsageMicroUsd: 1_000_000,
      }),
    ).toBe(1_200_000);
  });
});

describe('switching managed provider does not revalue a wallet (AICO-186 regression)', () => {
  it('leaves raw capacity bought at 1.2x alone and bills only later usage at 1.25x', () => {
    // $12 topped up while OpenRouter was live bought $10 of raw capacity.
    const capacity = rawCapacityFromDeposit(12 * USD, 12_000);
    expect(capacity).toBe(10 * USD);

    let checkpoint: UsageMultiplierCheckpoint = {
      billedUsageBeforeBaselineMicroUsd: 0,
      checkpointMultiplierBp: 12_000,
      usageBaselineMicroUsd: 0,
    };
    const rawAtSwitch = 5 * USD;

    // AICO_MANAGED_PROVIDER flips to cheapvibecode: an ordinary rate change.
    checkpoint = {
      ...rebaseCheckpoint({ checkpoint, nextBp: 12_500, rawUsage: rawAtSwitch }),
      checkpointMultiplierBp: 12_500,
    };

    // The capacity the user already paid for is not recomputed at the new rate;
    // only spend after the switch is billed at 1.25x.
    expect(rawCapacityFromDeposit(12 * USD, 12_000)).toBe(capacity);
    expect(checkpoint.billedUsageBeforeBaselineMicroUsd).toBe(6 * USD);
    expect(
      billedUsageFromRaw({
        baselineRaw: Number(checkpoint.usageBaselineMicroUsd),
        billedBefore: Number(checkpoint.billedUsageBeforeBaselineMicroUsd),
        bp: checkpoint.checkpointMultiplierBp,
        rawUsage: rawAtSwitch + 4 * USD,
      }),
    ).toBe(11 * USD); // $6 at the old rate + $5 of raw spend at 1.25x
  });
});

describe('defaultMultiplierBpForProvider', () => {
  it('seeds each managed provider at its own rate', () => {
    expect(defaultMultiplierBpForProvider('openrouter')).toBe(12_000);
    expect(defaultMultiplierBpForProvider('cheapvibecode')).toBe(12_500);
  });

  it('falls back to the platform default for an unknown provider', () => {
    expect(defaultMultiplierBpForProvider('something-else')).toBe(12_000);
    expect(defaultMultiplierBpForProvider(undefined)).toBe(12_000);
  });
});

describe('assertValidModelMultiplierBp', () => {
  // Wider, and open below 1.00x, than the platform band: a per-model override
  // corrects a published coefficient that can be wrong in either direction.
  it('accepts discounts and large markups inside 0.10x - 10.00x', () => {
    expect(assertValidModelMultiplierBp(3_000)).toBe(3_000);
    expect(assertValidModelMultiplierBp(1_000)).toBe(1_000);
    expect(assertValidModelMultiplierBp(100_000)).toBe(100_000);
  });

  it('rejects out-of-band overrides', () => {
    expect(() => assertValidModelMultiplierBp(999)).toThrow('INVALID_MODEL_MULTIPLIER');
    expect(() => assertValidModelMultiplierBp(100_001)).toThrow('INVALID_MODEL_MULTIPLIER');
    expect(() => assertValidModelMultiplierBp(Number.NaN)).toThrow('INVALID_MODEL_MULTIPLIER');
  });
});

describe('rotateCheckpointToNewKey (CheapVibeCode has no update endpoint)', () => {
  it('carries billed usage forward and restarts the baseline at the new key origin', () => {
    // $8 raw spent at 1.25x = $10 billed, on a key that is about to be retired.
    const checkpoint: UsageMultiplierCheckpoint = {
      billedUsageBeforeBaselineMicroUsd: 0,
      checkpointMultiplierBp: 12_500,
      usageBaselineMicroUsd: 0,
    };

    const rotated = rotateCheckpointToNewKey({ checkpoint, finalRawUsage: 8 * USD });

    expect(rotated.billedUsageBeforeBaselineMicroUsd).toBe(10 * USD);
    // The new key's counter starts at zero, so the baseline must too.
    expect(rotated.usageBaselineMicroUsd).toBe(0);
  });

  it('is exact across a rotation: usage is unchanged the instant the key swaps', () => {
    const checkpoint: UsageMultiplierCheckpoint = {
      billedUsageBeforeBaselineMicroUsd: 0,
      checkpointMultiplierBp: 12_500,
      usageBaselineMicroUsd: 0,
    };
    const before = billedUsageFromRaw({
      baselineRaw: 0,
      billedBefore: 0,
      bp: 12_500,
      rawUsage: 8 * USD,
    });

    const rotated = rotateCheckpointToNewKey({ checkpoint, finalRawUsage: 8 * USD });
    const after = billedUsageFromRaw({
      baselineRaw: rotated.usageBaselineMicroUsd,
      billedBefore: rotated.billedUsageBeforeBaselineMicroUsd,
      bp: 12_500,
      rawUsage: 0,
    });

    expect(after).toBe(before);
  });

  it('accumulates across repeated rotations rather than forgetting earlier keys', () => {
    let checkpoint: UsageMultiplierCheckpoint = {
      billedUsageBeforeBaselineMicroUsd: 0,
      checkpointMultiplierBp: 12_500,
      usageBaselineMicroUsd: 0,
    };

    for (let i = 0; i < 3; i += 1) {
      const rotated = rotateCheckpointToNewKey({ checkpoint, finalRawUsage: 4 * USD });
      checkpoint = { ...checkpoint, ...rotated };
    }

    // 3 x $4 raw at 1.25x = $15 billed, carried in full.
    expect(checkpoint.billedUsageBeforeBaselineMicroUsd).toBe(15 * USD);
  });

  it('keeps the old rate on old usage when a rotation follows a rate change', () => {
    // $8 raw already billed at 1.20x, then the key rotates under a 1.25x regime.
    const checkpoint: UsageMultiplierCheckpoint = {
      billedUsageBeforeBaselineMicroUsd: 0,
      checkpointMultiplierBp: 12_000,
      usageBaselineMicroUsd: 0,
    };

    const rotated = rotateCheckpointToNewKey({ checkpoint, finalRawUsage: 8 * USD });

    // Billed at the checkpoint's own rate, not at whatever is current.
    expect(rotated.billedUsageBeforeBaselineMicroUsd).toBe(9_600_000);
  });
});

describe('rawUsageFromRemaining (CheapVibeCode reports only what is left)', () => {
  it('derives spend as the part of the mint-time limit no longer covered', () => {
    expect(rawUsageFromRemaining({ limitMicroUsd: 800_000, remainingMicroUsd: 600_000 })).toBe(
      200_000,
    );
    expect(rawUsageFromRemaining({ limitMicroUsd: 800_000, remainingMicroUsd: 0 })).toBe(800_000);
    expect(rawUsageFromRemaining({ limitMicroUsd: 800_000, remainingMicroUsd: 800_000 })).toBe(0);
  });

  it('returns null — never 0 — when the limit is unknown', () => {
    // 0 would read as "spent nothing" and re-grant the whole cap.
    expect(rawUsageFromRemaining({ limitMicroUsd: null, remainingMicroUsd: 600_000 })).toBeNull();
    expect(
      rawUsageFromRemaining({ limitMicroUsd: undefined, remainingMicroUsd: 600_000 }),
    ).toBeNull();
    expect(
      rawUsageFromRemaining({ limitMicroUsd: Number.NaN, remainingMicroUsd: 600_000 }),
    ).toBeNull();
  });

  it('returns null when the remaining reading is unusable', () => {
    expect(rawUsageFromRemaining({ limitMicroUsd: 800_000, remainingMicroUsd: null })).toBeNull();
    expect(
      rawUsageFromRemaining({ limitMicroUsd: 800_000, remainingMicroUsd: Number.NaN }),
    ).toBeNull();
    expect(rawUsageFromRemaining({ limitMicroUsd: 800_000, remainingMicroUsd: -1 })).toBeNull();
  });

  it('floors at zero when a stale limit is below the reported remaining', () => {
    expect(rawUsageFromRemaining({ limitMicroUsd: 500_000, remainingMicroUsd: 800_000 })).toBe(0);
  });
});

describe('π tokens (user-facing unit)', () => {
  const CVC = 25_000_000;

  it('maps $0.80 raw to 20_000 π at the CVC bridge rate', () => {
    expect(rawMicroUsdToPiTokens(800_000, CVC)).toBe(20_000);
    expect(rawMicroUsdToPiTokens(1 * USD, CVC)).toBe(25_000);
  });

  it('credits 20_000 π for a $1 top-up at 1.25×', () => {
    expect(topupPiTokensPerUsd(12_500, CVC)).toBe(20_000);
    expect(topupPiTokensFromDeposit(1 * USD, 12_500, CVC)).toBe(20_000);
    expect(topupPiTokensFromDeposit(5 * USD, 12_500, CVC)).toBe(100_000);
  });

  it('converts billed remaining to π via the blended wallet rate', () => {
    // $5 billed bought $4 raw → remaining $2.5 billed ≡ $2 raw ≡ 50_000 π
    expect(
      billedMicroUsdToPiTokens({
        balanceMicroUsd: 5 * USD,
        billedMicroUsd: 2.5 * USD,
        cvcTokensPerUsd: CVC,
        rawCapacityMicroUsd: 4 * USD,
      }),
    ).toBe(50_000);
  });

  it('round-trips whole π amounts through raw micro-USD', () => {
    expect(piTokensToRawMicroUsd(20_000, CVC)).toBe(800_000);
    expect(rawMicroUsdToPiTokens(piTokensToRawMicroUsd(20_000, CVC), CVC)).toBe(20_000);
  });

  it('floors fractional π so remaining never overstates capacity', () => {
    // 1 micro-USD at 25M/USD → 0.025 π → floor 0
    expect(rawMicroUsdToPiTokens(1, CVC)).toBe(0);
    expect(rawUsdToPiTokensDecimal(0.000_001, CVC)).toBeCloseTo(0.025, 6);
  });
});
