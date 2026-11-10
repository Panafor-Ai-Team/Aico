import { type LobeDefaultAiModelListItem } from 'model-bank';
import { describe, expect, it } from 'vitest';

import { resolveStableModelCard } from './resolveStableModelCard';

const card = (overrides: Partial<LobeDefaultAiModelListItem> = {}): LobeDefaultAiModelListItem =>
  ({
    abilities: {},
    displayName: 'Model',
    id: 'openai/gpt-4o-mini',
    providerId: 'openrouter',
    ...overrides,
  }) as LobeDefaultAiModelListItem;

describe('resolveStableModelCard', () => {
  it('takes the incoming card when there is no previous one', () => {
    const next = card({ pricing: { units: [] } as any });
    expect(resolveStableModelCard(undefined, next)).toBe(next);
  });

  it('keeps the previous card when the store transiently yields nothing', () => {
    const previous = card({ pricing: { units: [] } as any });
    expect(resolveStableModelCard(previous, undefined)).toBe(previous);
  });

  it('never downgrades to a pricing-less card for the same model', () => {
    const previous = card({ pricing: { units: [{ name: 'textInput' }] } as any });
    const pricingLess = card({ pricing: undefined });

    expect(resolveStableModelCard(previous, pricingLess)).toBe(previous);
  });

  it('adopts a new priced card for the same model', () => {
    const previous = card({ pricing: { units: [] } as any });
    const next = card({ pricing: { units: [{ name: 'textInput' }] } as any });

    expect(resolveStableModelCard(previous, next)).toBe(next);
  });

  it('always adopts the card when the model itself changed', () => {
    const previous = card({ id: 'openai/gpt-4o-mini', pricing: { units: [] } as any });
    const next = card({ id: 'openai/gpt-4o', pricing: undefined });

    expect(resolveStableModelCard(previous, next)).toBe(next);
  });
});
