import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import {
  platformModelMultiplierOverrides,
  platformUsageMultiplierConfig,
} from '../../schemas/aicoOrganization';
import type { LobeChatDatabase } from '../../type';
import { AicoBillingModel } from '../aicoBilling';

const serverDB: LobeChatDatabase = await getTestDB();
const model = new AicoBillingModel(serverDB);

/**
 * A synthetic provider id, not one of the real managed providers: the override
 * table is global and other suites share this database, so the fixture must not
 * touch a row a live code path would read.
 */
const providerId = 'test-model-multiplier-provider';

const cleanup = () =>
  serverDB
    .delete(platformModelMultiplierOverrides)
    .where(eq(platformModelMultiplierOverrides.providerId, providerId));

beforeEach(cleanup);
afterEach(cleanup);

describe('AICO-187 per-model coefficient overrides', () => {
  it('has no overrides until an admin sets one', async () => {
    expect(await model.getModelMultiplierOverrideMap(providerId)).toEqual({});
  });

  it('stores an override and serves it as a modelId -> bp map', async () => {
    await model.setModelMultiplierOverride({
      modelId: 'deepseek-v4.1-flash',
      multiplierBp: 14_430,
      note: 'measured x0.433 against an advertised x0.3',
      providerId,
    });

    expect(await model.getModelMultiplierOverrideMap(providerId)).toEqual({
      'deepseek-v4.1-flash': 14_430,
    });
  });

  it('upserts on (provider, model) rather than accumulating rows', async () => {
    await model.setModelMultiplierOverride({
      modelId: 'mimo-v2.5',
      multiplierBp: 14_000,
      providerId,
    });
    await model.setModelMultiplierOverride({
      modelId: 'mimo-v2.5',
      multiplierBp: 14_500,
      providerId,
    });

    const rows = await model.listModelMultiplierOverrides(providerId);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].multiplierBp)).toBe(14_500);
  });

  it('scopes overrides to their provider', async () => {
    await model.setModelMultiplierOverride({
      modelId: 'glm-5.3-flash',
      multiplierBp: 9_000,
      providerId,
    });

    expect(await model.getModelMultiplierOverrideMap(`${providerId}-other`)).toEqual({});
  });

  it('accepts a discount, which the platform multiplier band would reject', async () => {
    await model.setModelMultiplierOverride({
      modelId: 'glm-5.3-flash',
      multiplierBp: 5_000,
      providerId,
    });

    expect(await model.getModelMultiplierOverrideMap(providerId)).toEqual({
      'glm-5.3-flash': 5_000,
    });
  });

  it('refuses an override outside 0.10x - 10.00x', async () => {
    await expect(
      model.setModelMultiplierOverride({ modelId: 'glm-5.3-flash', multiplierBp: 999, providerId }),
    ).rejects.toThrow('INVALID_MODEL_MULTIPLIER');
    await expect(
      model.setModelMultiplierOverride({
        modelId: 'glm-5.3-flash',
        multiplierBp: 100_001,
        providerId,
      }),
    ).rejects.toThrow('INVALID_MODEL_MULTIPLIER');
  });

  it('clears an override back to the published coefficient', async () => {
    await model.setModelMultiplierOverride({
      modelId: 'glm-5.3-flash',
      multiplierBp: 12_000,
      providerId,
    });
    await model.clearModelMultiplierOverride({ modelId: 'glm-5.3-flash', providerId });

    expect(await model.getModelMultiplierOverrideMap(providerId)).toEqual({});
  });
});

describe('getUsageMultiplierBp is read-only (AICO-186)', () => {
  const unknownProvider = 'test-unseeded-provider';

  afterEach(() =>
    serverDB
      .delete(platformUsageMultiplierConfig)
      .where(eq(platformUsageMultiplierConfig.id, unknownProvider)),
  );

  it('does not seed a config row for a provider it has never seen', async () => {
    // creditWallet reads this with an open transaction handle. A write there
    // would sit inside a wallet transaction, and a failure would abort that
    // transaction even though the read itself swallows the error.
    const bp = await model.getUsageMultiplierBp(unknownProvider);
    expect(bp).toBeGreaterThan(0);

    const row = await serverDB.query.platformUsageMultiplierConfig.findFirst({
      where: eq(platformUsageMultiplierConfig.id, unknownProvider),
    });
    expect(row).toBeUndefined();
  });
});
