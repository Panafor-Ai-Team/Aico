import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { LobeChatDatabase } from '@/database/type';

import {
  getManagedModelRates,
  type ManagedModelRates,
  rateToPusdPerToken,
  rawCostMicroUsd,
  resetManagedPricingCacheForTests,
  resolveChatRates,
} from '../pricing';

const catalogRows = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[] }));

vi.mock('@/database/models/openrouterModelCatalog', () => ({
  OpenRouterModelCatalogModel: class {
    listPricingRows = async () => catalogRows.rows;
  },
}));

const db = {} as LobeChatDatabase;

const cvcPricing = (coefficient: number) => ({
  units: [
    { name: 'textInput', rate: coefficient * 0.04, strategy: 'fixed', unit: 'millionTokens' },
    { name: 'textOutput', rate: coefficient * 0.04, strategy: 'fixed', unit: 'millionTokens' },
  ],
});

const row = (id: string, coefficient: number, extra: Record<string, unknown> = {}) => ({
  contextWindowTokens: 200_000,
  id,
  maxOutput: 32_000,
  pricing: cvcPricing(coefficient),
  type: 'chat',
  ...extra,
});

const glmRates = (extra: Partial<ManagedModelRates> = {}): ManagedModelRates => ({
  contextWindowTokens: 200_000,
  inputPusdPerToken: 12_000n,
  maxOutputTokens: 32_000,
  modelBp: 10_000,
  outputPusdPerToken: 12_000n,
  pricedModelId: 'glm-5.3-flash',
  reasoningBilledTwice: false,
  ...extra,
});

beforeEach(() => {
  resetManagedPricingCacheForTests();
  catalogRows.rows = [
    row('glm-5.3-flash', 0.3),
    row('grok-4.6', 0.5),
    row('gpt-5.6-luna', 0.33),
    row('gpt-5.6-terra', 1.5),
    row('deepseek-v4.1-flash', 0.3),
  ];
});

describe('rateToPusdPerToken', () => {
  it('converts a CVC coefficient rate exactly', () => {
    expect(rateToPusdPerToken(0.3 * 0.04)).toBe(12_000n);
    expect(rateToPusdPerToken(8 * 0.04)).toBe(320_000n);
  });
});

describe('rawCostMicroUsd', () => {
  const tokens = { completion: 500, prompt: 1000, reasoning: 0, total: 1500 };

  it('charges every token at the coefficient rate, rounded up to µUSD', () => {
    expect(rawCostMicroUsd(glmRates(), tokens)).toBe(Math.ceil((1500 * 12_000) / 1e6));
  });

  it('adds reasoning a second time for double-billing models', () => {
    const rates = glmRates({ reasoningBilledTwice: true });
    expect(rawCostMicroUsd(rates, { ...tokens, reasoning: 300 })).toBe(
      Math.ceil((1800 * 12_000) / 1e6),
    );
  });

  it('applies a model correction', () => {
    expect(rawCostMicroUsd(glmRates({ modelBp: 20_000 }), tokens)).toBe(
      Math.ceil((3000 * 12_000) / 1e6),
    );
  });

  it('takes the larger of double-billing and the correction, never the sum', () => {
    const rates = glmRates({ modelBp: 15_000, reasoningBilledTwice: true });
    // twice: 1500 + 300 = 1800 tokens; corrected: 1500 × 1.5 = 2250 tokens.
    expect(rawCostMicroUsd(rates, { ...tokens, reasoning: 300 })).toBe(
      Math.ceil((2250 * 12_000) / 1e6),
    );
    // twice: 1500 + 1000 = 2500 tokens beats the correction.
    expect(rawCostMicroUsd(rates, { ...tokens, reasoning: 1000 })).toBe(
      Math.ceil((2500 * 12_000) / 1e6),
    );
  });

  it('charges total − prompt when it exceeds reported completion', () => {
    expect(
      rawCostMicroUsd(glmRates(), { completion: 100, prompt: 1000, reasoning: 0, total: 1800 }),
    ).toBe(Math.ceil((1800 * 12_000) / 1e6));
  });

  it('prices input-only models', () => {
    const rates = glmRates({ outputPusdPerToken: null });
    expect(
      rawCostMicroUsd(rates, { completion: 0, prompt: 100_000, reasoning: 0, total: 100_000 }),
    ).toBe(1200);
  });
});

describe('getManagedModelRates', () => {
  it('reads catalog rates and caps with no per-model correction', async () => {
    await expect(getManagedModelRates(db, 'glm-5.3-flash')).resolves.toEqual(glmRates());
  });

  it('flags double-billing models', async () => {
    expect((await getManagedModelRates(db, 'deepseek-v4.1-flash'))?.reasoningBilledTwice).toBe(
      true,
    );
  });

  it('returns null for an unknown id', async () => {
    await expect(getManagedModelRates(db, 'unknown-model')).resolves.toBeNull();
  });

  it('never prices an OpenRouter-only id', async () => {
    await expect(getManagedModelRates(db, 'openai/gpt-4o')).resolves.toBeNull();
  });

  it('falls back to the bundled CVC snapshot by exact id', async () => {
    catalogRows.rows = [];
    const rates = await getManagedModelRates(db, 'mimo-v2.5');
    expect(rates).toMatchObject({
      inputPusdPerToken: rateToPusdPerToken(0.05 * 0.04),
      pricedModelId: 'mimo-v2.5',
      reasoningBilledTwice: true,
    });
  });

  it('refuses tiered or missing input pricing', async () => {
    catalogRows.rows = [
      row('tiered', 1, {
        pricing: { units: [{ name: 'textInput', strategy: 'tiered', unit: 'millionTokens' }] },
      }),
      row('no-pricing', 1, { pricing: null }),
    ];
    await expect(getManagedModelRates(db, 'tiered')).resolves.toBeNull();
    await expect(getManagedModelRates(db, 'no-pricing')).resolves.toBeNull();
  });
});

describe('resolveChatRates', () => {
  const route = {
    default: 'glm-5.3-flash',
    reasoning: 'grok-4.6',
    vision: 'gpt-5.6-luna',
    visionTools: 'gpt-5.6-terra',
  };

  it('prices a concrete model as itself', async () => {
    const result = await resolveChatRates(db, { messages: [], model: 'grok-4.6' } as never, route);
    expect(result?.modelId).toBe('grok-4.6');
  });

  it('prices Auto with an image and tools as the visionTools slot', async () => {
    const payload = {
      messages: [{ content: [{ image_url: { url: 'x' }, type: 'image_url' }], role: 'user' }],
      model: 'auto',
      tools: [{ function: { name: 't' }, type: 'function' }],
    };
    const result = await resolveChatRates(db, payload as never, route);
    expect(result?.modelId).toBe('gpt-5.6-terra');
  });

  it('prices an unpriced Auto target as the most expensive slot', async () => {
    catalogRows.rows = catalogRows.rows.filter((r) => r.id !== 'glm-5.3-flash');
    const result = await resolveChatRates(db, { messages: [], model: 'auto' } as never, {
      ...route,
      default: 'not-in-catalog',
    });
    expect(result?.modelId).toBe('gpt-5.6-terra');
  });

  it('returns null when no slot is priced', async () => {
    catalogRows.rows = [];
    const result = await resolveChatRates(db, { messages: [], model: 'auto' } as never, {
      default: 'a',
      reasoning: 'b',
      vision: 'c',
      visionTools: 'd',
    });
    expect(result).toBeNull();
  });
});
