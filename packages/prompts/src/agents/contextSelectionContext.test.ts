import { describe, expect, it } from 'vitest';

import { PROMPT_CONTENT_BUDGET } from './contentBudget';
import { formatContextSelections } from './contextSelectionContext';

describe('formatContextSelections', () => {
  it('leaves small selections untouched', () => {
    const result = formatContextSelections([{ content: 'hello', source: 'chat' } as any]);

    expect(result).toContain('hello');
    expect(result).not.toContain('[truncated:');
  });

  it('truncates a huge selection batch with a note', () => {
    const big = 'z'.repeat(PROMPT_CONTENT_BUDGET + 100);
    const result = formatContextSelections([{ content: `${big}TAIL-CTX` } as any]);

    expect(result).not.toContain('TAIL-CTX');
    expect(result).toContain('[truncated:');
  });
});
