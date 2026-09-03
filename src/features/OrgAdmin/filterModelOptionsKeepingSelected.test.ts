import { describe, expect, it } from 'vitest';

import { filterModelOptionsKeepingSelected } from './filterModelOptionsKeepingSelected';

const options = [
  { label: 'GPT-4o mini (openai/gpt-4o-mini)', value: 'openai/gpt-4o-mini' },
  { label: 'Auto (openrouter/auto)', value: 'openrouter/auto' },
  {
    label: 'Claude 3.5 Sonnet (anthropic/claude-3.5-sonnet)',
    value: 'anthropic/claude-3.5-sonnet',
  },
];

describe('filterModelOptionsKeepingSelected', () => {
  it('returns all options when the query is empty', () => {
    expect(filterModelOptionsKeepingSelected(options, '', [])).toEqual(options);
  });

  it('matches by label or id, case-insensitively', () => {
    expect(filterModelOptionsKeepingSelected(options, 'gpt-4o', []).map((o) => o.value)).toEqual([
      'openai/gpt-4o-mini',
    ]);
    expect(filterModelOptionsKeepingSelected(options, 'AUTO', []).map((o) => o.value)).toEqual([
      'openrouter/auto',
    ]);
  });

  it('keeps an already-selected id visible even when the query does not match it', () => {
    // Regression: the team-model picker resubmits whatever this list renders as
    // "selected". If a currently-granted model drops out of view while the
    // admin searches for a different one to add, the underlying multi-select
    // loses track of it and the save silently un-grants it.
    const result = filterModelOptionsKeepingSelected(options, 'Auto', ['openai/gpt-4o-mini']);
    expect(result.map((o) => o.value)).toEqual(
      expect.arrayContaining(['openai/gpt-4o-mini', 'openrouter/auto']),
    );
    expect(result).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ value: 'anthropic/claude-3.5-sonnet' })]),
    );
  });
});
