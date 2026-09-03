import { describe, expect, it } from 'vitest';

import { excludeSelectedModelOptions } from './excludeSelectedModelOptions';

const options = [
  { label: 'GPT-4o mini (openai/gpt-4o-mini)', value: 'openai/gpt-4o-mini' },
  { label: 'Auto (openrouter/auto)', value: 'openrouter/auto' },
  {
    label: 'Claude 3.5 Sonnet (anthropic/claude-3.5-sonnet)',
    value: 'anthropic/claude-3.5-sonnet',
  },
];

describe('excludeSelectedModelOptions', () => {
  it('returns every option when nothing is selected yet', () => {
    expect(excludeSelectedModelOptions(options, [])).toEqual(options);
  });

  it('drops options already granted so they cannot be picked twice', () => {
    const result = excludeSelectedModelOptions(options, ['openai/gpt-4o-mini']);
    expect(result.map((o) => o.value)).toEqual(['openrouter/auto', 'anthropic/claude-3.5-sonnet']);
  });

  it('returns an empty list once every option is already granted', () => {
    const result = excludeSelectedModelOptions(
      options,
      options.map((o) => o.value),
    );
    expect(result).toEqual([]);
  });
});
