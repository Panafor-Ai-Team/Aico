import { describe, expect, it } from 'vitest';

import { PROMPT_CONTENT_BUDGET } from './contentBudget';
import { formatPageSelections } from './pageSelectionContext';

describe('formatPageSelections', () => {
  it('leaves small selections untouched', () => {
    const result = formatPageSelections([{ xml: '<p id="1">Hello</p>' } as any]);

    expect(result).toContain('<p id="1">Hello</p>');
    expect(result).not.toContain('[truncated:');
  });

  it('truncates a huge selection batch with a note', () => {
    const big = 'y'.repeat(PROMPT_CONTENT_BUDGET + 100);
    const result = formatPageSelections([{ xml: `${big}TAIL-SEL` } as any]);

    expect(result).not.toContain('TAIL-SEL');
    expect(result).toContain('[truncated:');
  });
});
