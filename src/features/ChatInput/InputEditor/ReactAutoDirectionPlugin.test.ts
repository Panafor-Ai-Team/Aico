import { describe, expect, it } from 'vitest';

import { planEditorDirection } from './ReactAutoDirectionPlugin';

/**
 * Regression: the plugin used to set a direction on every top-level block from
 * that block's own first strong character. A Persian line and an English line in
 * one message then aligned to opposite edges of the composer, and typing a Latin
 * character at the start of a line jumped that line across the box.
 *
 * The rule now: the root carries one direction for the whole text, and no block
 * carries a direction of its own.
 */
describe('planEditorDirection', () => {
  it('takes the direction from the first strong character of the whole text', () => {
    expect(
      planEditorDirection({ blockDirections: [], rootDirection: null, rootText: 'سلام Hello دنیا' })
        .rootDirection,
    ).toBe('rtl');

    expect(
      planEditorDirection({ blockDirections: [], rootDirection: null, rootText: 'Hello سلام' })
        .rootDirection,
    ).toBe('ltr');
  });

  it('does not let a later line change the direction', () => {
    // Persian first line, English second — one direction, decided by line one.
    expect(
      planEditorDirection({
        blockDirections: [null, null],
        rootDirection: null,
        rootText: 'سلام دنیا Hello world',
      }).rootDirection,
    ).toBe('rtl');
  });

  it('requests an update while any block still carries its own direction', () => {
    expect(
      planEditorDirection({
        blockDirections: ['rtl', 'ltr'],
        rootDirection: 'rtl',
        rootText: 'سلام دنیا',
      }).needsUpdate,
    ).toBe(true);
  });

  it('is settled once the root matches and no block overrides it', () => {
    expect(
      planEditorDirection({
        blockDirections: [null, null],
        rootDirection: 'rtl',
        rootText: 'سلام دنیا',
      }).needsUpdate,
    ).toBe(false);
  });

  it('leaves direction unset for text with no strong character', () => {
    const plan = planEditorDirection({
      blockDirections: [],
      rootDirection: null,
      rootText: '123 ...',
    });

    expect(plan.rootDirection).toBeNull();
    expect(plan.needsUpdate).toBe(false);
  });
});
