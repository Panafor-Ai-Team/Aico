import { describe, expect, it } from 'vitest';

import { searchMemorySchema } from './tools';

describe('searchMemorySchema', () => {
  // Production 2026-11-09: the model sent `categories: [""]` and `labels: [""]`, and the
  // whole memory search failed with BAD_REQUEST instead of searching without a filter.
  it('drops blank filter values instead of rejecting the search', () => {
    const result = searchMemorySchema.safeParse({
      categories: [''],
      labels: ['  ', 'work'],
      queries: ['favourite food'],
    });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      categories: [],
      labels: ['work'],
      queries: ['favourite food'],
    });
  });

  it('still wraps a single string and trims values', () => {
    const result = searchMemorySchema.safeParse({ tags: '  travel ' });

    expect(result.success).toBe(true);
    expect(result.data?.tags).toEqual(['travel']);
  });

  it('still rejects non-string filter values', () => {
    expect(searchMemorySchema.safeParse({ categories: [42] }).success).toBe(false);
  });
});
