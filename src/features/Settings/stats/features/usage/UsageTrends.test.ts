import { describe, expect, it } from 'vitest';

import { GroupBy } from '../../types';
import { categoryLabel } from './UsageTrends';

describe('categoryLabel', () => {
  // The returned string becomes both the chart's grouping key and the visible
  // legend/tooltip label, so a raw provider-namespaced model id (e.g. the
  // stored `openrouter/auto`) must be branded before it reaches the chart.
  it('brands a model id for GroupBy.Model', () => {
    expect(categoryLabel('openrouter/auto', GroupBy.Model)).toBe('panachat/auto');
  });

  it('leaves a non-openrouter model id unchanged for GroupBy.Model', () => {
    expect(categoryLabel('gpt-5-mini', GroupBy.Model)).toBe('gpt-5-mini');
  });

  it('brands a provider id for GroupBy.Provider', () => {
    expect(categoryLabel('openrouter', GroupBy.Provider)).toBe('Panachat');
  });

  it('resolves the display name for GroupBy.User', () => {
    expect(
      categoryLabel('user-1', GroupBy.User, () => ({ avatar: null, name: 'Ada Lovelace' })),
    ).toBe('Ada Lovelace');
  });
});
