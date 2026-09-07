import { describe, expect, it } from 'vitest';

import {
  applyMultiplierMicroUsd,
  assertValidMultiplierBp,
  billedUsageFromCapacity,
  billedUsageFromRaw,
  blendedMultiplierBp,
  keyLimitFromBilled,
  rawCapacityFromDeposit,
  rebaseCheckpoint,
  removeMultiplierMicroUsd,
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
