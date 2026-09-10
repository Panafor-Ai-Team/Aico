import { describe, expect, it } from 'vitest';

import { NESTED_BLOCK_DIRECTION_SELECTOR } from './nestedBlockDirectionSelector';

describe('NESTED_BLOCK_DIRECTION_SELECTOR', () => {
  it('matches a nested block that still carries its own dir', () => {
    const quote = document.createElement('blockquote');
    quote.setAttribute('dir', 'rtl');

    expect(quote.matches(NESTED_BLOCK_DIRECTION_SELECTOR)).toBe(true);
  });

  it('does not match the editor root', () => {
    // Regression: the selector used to be bare `[dir]`, which also matched the
    // editor root. ReactAutoDirectionPlugin sets `dir` there from the first
    // strong character on every keystroke, and this rule forced it straight
    // back to 'inherit', silently discarding that value for the page direction.
    const root = document.createElement('div');
    root.setAttribute('dir', 'ltr');
    root.setAttribute('contenteditable', 'true');

    expect(root.matches(NESTED_BLOCK_DIRECTION_SELECTOR)).toBe(false);
  });
});
