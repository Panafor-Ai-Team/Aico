import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  cvcMultiplierToPricing,
  DEFAULT_CVC_TOKENS_PER_USD,
  fetchCheapVibeCodeModels,
  mapCheapVibeCodeModelCard,
} from './modelFetch';

const rateOf = (pricing: ReturnType<typeof cvcMultiplierToPricing>, name: string) =>
  pricing?.units.find((unit) => unit.name === name) as { rate: number } | undefined;

describe('cvcMultiplierToPricing', () => {
  it('converts a coefficient to USD per million tokens at the configured rate', () => {
    // 25M tokens per USD → one coefficient point costs 0.04 USD / 1M tokens.
    const pricing = cvcMultiplierToPricing(2);
    expect(rateOf(pricing, 'textInput')?.rate).toBeCloseTo(0.08, 10);
    expect(rateOf(pricing, 'textOutput')?.rate).toBeCloseTo(0.08, 10);
  });

  it('weighs input and output equally, because CVC does', () => {
    const pricing = cvcMultiplierToPricing(0.33);
    expect(rateOf(pricing, 'textInput')?.rate).toBe(rateOf(pricing, 'textOutput')?.rate);
  });

  it('publishes no cache-read discount, because cached tokens are billed in full', () => {
    expect(cvcMultiplierToPricing(2)?.units.map((unit) => unit.name)).toEqual([
      'textInput',
      'textOutput',
    ]);
  });

  it.each([0, -1, null, undefined, Number.NaN])(
    'returns undefined rather than a free price for %s',
    (multiplier) => {
      expect(cvcMultiplierToPricing(multiplier as never)).toBeUndefined();
    },
  );

  it('honours AICO_CVC_TOKENS_PER_USD', () => {
    vi.stubEnv('AICO_CVC_TOKENS_PER_USD', String(DEFAULT_CVC_TOKENS_PER_USD / 2));
    // Half the tokens per dollar means twice the price.
    expect(rateOf(cvcMultiplierToPricing(2), 'textInput')?.rate).toBeCloseTo(0.16, 10);
    vi.unstubAllEnvs();
  });

  it('ignores a nonsense token rate rather than re-denominating everything', () => {
    vi.stubEnv('AICO_CVC_TOKENS_PER_USD', '0');
    expect(rateOf(cvcMultiplierToPricing(2), 'textInput')?.rate).toBeCloseTo(0.08, 10);
    vi.unstubAllEnvs();
  });
});

describe('mapCheapVibeCodeModelCard', () => {
  it('maps the published metadata onto a chat card', () => {
    const card = mapCheapVibeCodeModelCard({
      context_window: 1_050_000,
      display_name: 'GPT-5.6 Luna',
      id: 'gpt-5.6-luna',
      max_output_tokens: 128_000,
      multiplier: 0.33,
      supports_reasoning: true,
      supports_tools: false,
      supports_vision: true,
    });

    expect(card).toMatchObject({
      abilities: { functionCall: false, reasoning: true, vision: true },
      contextWindowTokens: 1_050_000,
      displayName: 'GPT-5.6 Luna',
      id: 'gpt-5.6-luna',
      maxOutput: 128_000,
      type: 'chat',
    });
  });

  it('treats max_output_tokens: 0 as unpublished, not as a zero-length cap', () => {
    // Three models in the live catalog report 0. Passing it through would cap
    // every reply at nothing.
    expect(
      mapCheapVibeCodeModelCard({ id: 'grok-4.6', max_output_tokens: 0 }).maxOutput,
    ).toBeUndefined();
  });

  it('falls back through display_name → name → id', () => {
    expect(mapCheapVibeCodeModelCard({ id: 'x', name: 'X Model' }).displayName).toBe('X Model');
    expect(mapCheapVibeCodeModelCard({ id: 'x' }).displayName).toBe('x');
  });
});

describe('fetchCheapVibeCodeModels', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const ok = (body: unknown) =>
    fetchMock.mockResolvedValue({ json: async () => body, ok: true, status: 200 });

  it('calls /models on the configured base URL with the key', async () => {
    ok({ data: [{ id: 'gpt-5.6-luna', multiplier: 0.33 }] });

    await fetchCheapVibeCodeModels({
      client: { apiKey: 'sk-test', baseURL: 'https://alt.example/v1/' },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://alt.example/v1/models',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer sk-test');
  });

  it('accepts either `data` or `models` as the array key', async () => {
    ok({ models: [{ id: 'glm-5.3-flash', multiplier: 0.3 }] });
    const models = await fetchCheapVibeCodeModels({ client: {} });
    expect(models.map((model) => model.id)).toContain('glm-5.3-flash');
  });

  it('drops entries without a string id instead of synthesizing one', async () => {
    ok({ data: [{ multiplier: 1 }, { id: 'grok-4.6', multiplier: 0.5 }] });
    const models = await fetchCheapVibeCodeModels({ client: {} });
    expect(models.map((model) => model.id)).toEqual(['grok-4.6']);
  });

  it('returns an empty list, not a throw, for a response with no array', async () => {
    ok({ error: 'nope' });
    await expect(fetchCheapVibeCodeModels({ client: {} })).resolves.toEqual([]);
  });

  it('throws on a non-2xx without echoing the body, which can contain the key', async () => {
    fetchMock.mockResolvedValue({
      json: async () => ({}),
      ok: false,
      status: 401,
      text: async () => 'Bearer sk-cvc-secret rejected',
    });

    await expect(fetchCheapVibeCodeModels({ client: { apiKey: 'sk-cvc-secret' } })).rejects.toThrow(
      /HTTP 401/,
    );
    await expect(
      fetchCheapVibeCodeModels({ client: { apiKey: 'sk-cvc-secret' } }),
    ).rejects.not.toThrow(/sk-cvc-secret/);
  });

  it('sends no Authorization header when there is no key', async () => {
    ok({ data: [] });
    await fetchCheapVibeCodeModels({ client: { apiKey: null } });
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });
});
