import { describe, expect, it } from 'vitest';

import {
  estimateChatInputTokens,
  estimateEmbeddingInputTokens,
  holdRawForChat,
  IMAGE_PART_TOKENS,
  MIN_OUTPUT_TOKENS,
  REQUEST_OVERHEAD_TOKENS,
  resolveMaxOutputTokens,
  shrinkMaxOutputToFit,
} from '../estimate';
import type { ManagedModelRates } from '../pricing';

const rates: ManagedModelRates = {
  contextWindowTokens: null,
  inputPusdPerToken: 12_000n,
  maxOutputTokens: null,
  modelBp: 10_000,
  outputPusdPerToken: 12_000n,
  pricedModelId: 'glm-5.3-flash',
  reasoningBilledTwice: false,
};

describe('estimateChatInputTokens', () => {
  it('counts at least one token per Persian character', () => {
    const text = 'س'.repeat(1000);
    const tokens = estimateChatInputTokens({ messages: [{ content: text, role: 'user' }] }, null);
    expect(tokens).toBeGreaterThanOrEqual(1000);
  });

  it('counts an image part as a flat cost and ignores its base64 body', () => {
    const base = estimateChatInputTokens({ messages: [{ content: [], role: 'user' }] }, null);
    const withImage = estimateChatInputTokens(
      {
        messages: [
          {
            content: [
              {
                image_url: { url: `data:image/png;base64,${'A'.repeat(500_000)}` },
                type: 'image_url',
              },
            ],
            role: 'user',
          },
        ],
      },
      null,
    );
    expect(withImage - base).toBeGreaterThanOrEqual(IMAGE_PART_TOKENS);
    expect(withImage - base).toBeLessThan(IMAGE_PART_TOKENS + 20);
  });

  it('includes tools and the request overhead', () => {
    const plain = estimateChatInputTokens({ messages: [] }, null);
    const withTools = estimateChatInputTokens(
      { messages: [], tools: [{ description: 'x'.repeat(1000) }] },
      null,
    );
    expect(plain).toBeGreaterThan(REQUEST_OVERHEAD_TOKENS);
    expect(withTools - plain).toBeGreaterThanOrEqual(500);
  });

  it('never exceeds the context window', () => {
    expect(
      estimateChatInputTokens({ messages: [{ content: 'x'.repeat(100_000), role: 'user' }] }, 1000),
    ).toBe(1000);
  });
});

describe('estimateEmbeddingInputTokens', () => {
  it('sums every input', () => {
    expect(estimateEmbeddingInputTokens(['ab', 'cd'], null)).toBe(2 * (1 + 16));
  });
});

describe('resolveMaxOutputTokens', () => {
  it.each([
    [{ defaultMax: 32_000, modelMax: null, requested: undefined }, 32_000],
    [{ defaultMax: 32_000, modelMax: 8000, requested: undefined }, 8000],
    [{ defaultMax: 32_000, modelMax: null, requested: 1000 }, 1000],
    [{ defaultMax: 32_000, modelMax: 8000, requested: 64_000 }, 8000],
    [{ defaultMax: 32_000, modelMax: null, requested: 64_000 }, 64_000],
    [{ defaultMax: 32_000, modelMax: 100_000, requested: 0 }, 32_000],
  ])('%o → %d', (params, expected) => {
    expect(resolveMaxOutputTokens(params)).toBe(expected);
  });
});

describe('shrinkMaxOutputToFit', () => {
  const identity = (raw: number) => raw;

  it('returns the largest output cap whose hold fits exactly', () => {
    const available = holdRawForChat(rates, 1000, 5000);
    const fit = shrinkMaxOutputToFit({
      available,
      estInput: 1000,
      maxOutput: 32_000,
      rates,
      toSubjectUnit: identity,
    });
    expect(fit).not.toBeNull();
    expect(holdRawForChat(rates, 1000, fit!)).toBeLessThanOrEqual(available);
    expect(holdRawForChat(rates, 1000, fit! + 1)).toBeGreaterThan(available);
  });

  it('returns null when not even the minimum output fits', () => {
    expect(
      shrinkMaxOutputToFit({
        available: holdRawForChat(rates, 1000, MIN_OUTPUT_TOKENS) - 1,
        estInput: 1000,
        maxOutput: 32_000,
        rates,
        toSubjectUnit: identity,
      }),
    ).toBeNull();
  });

  it('applies the subject unit conversion', () => {
    const double = (raw: number) => raw * 2;
    const available = holdRawForChat(rates, 1000, 5000);
    const fit = shrinkMaxOutputToFit({
      available,
      estInput: 1000,
      maxOutput: 32_000,
      rates,
      toSubjectUnit: double,
    })!;
    expect(double(holdRawForChat(rates, 1000, fit))).toBeLessThanOrEqual(available);
  });
});
