import { describe, expect, it } from 'vitest';

import { getDragSelectionCount, isDragInSelection } from './dragSelection';

describe('isDragInSelection', () => {
  it('uses plain membership for a normal selection', () => {
    expect(isDragInSelection('a', ['a', 'b'], 'loaded')).toBe(true);
    expect(isDragInSelection('c', ['a', 'b'], 'none')).toBe(false);
  });

  it('inverts membership in select-all mode, where the ids are exclusions', () => {
    expect(isDragInSelection('excluded', ['excluded'], 'all')).toBe(false);
    expect(isDragInSelection('other', ['excluded'], 'all')).toBe(true);
  });
});

describe('getDragSelectionCount', () => {
  it('counts the selected ids normally', () => {
    expect(getDragSelectionCount(['a', 'b'], 'loaded', 40)).toBe(2);
  });

  it('counts total minus exclusions in select-all mode', () => {
    expect(getDragSelectionCount(['x', 'y', 'z'], 'all', 40)).toBe(37);
    expect(getDragSelectionCount([], 'all', undefined)).toBe(0);
  });
});
