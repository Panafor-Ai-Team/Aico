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
      planEditorDirection({
        blockDirections: [],
        rootDirection: null,
        rootText: 'سلام Hello دنیا',
        uiDirection: 'ltr',
      }).rootDirection,
    ).toBe('rtl');

    expect(
      planEditorDirection({
        blockDirections: [],
        rootDirection: null,
        rootText: 'Hello سلام',
        uiDirection: 'rtl',
      }).rootDirection,
    ).toBe('ltr');
  });

  it('does not let a later line change the direction', () => {
    // Persian first line, English second — one direction, decided by line one.
    expect(
      planEditorDirection({
        blockDirections: [null, null],
        rootDirection: null,
        rootText: 'سلام دنیا Hello world',
        uiDirection: 'ltr',
      }).rootDirection,
    ).toBe('rtl');
  });

  it('requests an update while any block still carries its own direction', () => {
    expect(
      planEditorDirection({
        blockDirections: ['rtl', 'ltr'],
        rootDirection: 'rtl',
        rootText: 'سلام دنیا',
        uiDirection: 'rtl',
      }).needsUpdate,
    ).toBe(true);
  });

  it('is settled once the root matches and no block overrides it', () => {
    expect(
      planEditorDirection({
        blockDirections: [null, null],
        rootDirection: 'rtl',
        rootText: 'سلام دنیا',
        uiDirection: 'rtl',
      }).needsUpdate,
    ).toBe(false);
  });

  // An empty input must follow the UI language. Leaving the root unset made
  // Lexical fall back to dir="auto" per block, and dir="auto" on empty text
  // resolves to ltr even in an rtl UI — caret on the wrong side for Persian.
  it('falls back to the UI direction when there is no strong character', () => {
    expect(
      planEditorDirection({
        blockDirections: [],
        rootDirection: null,
        rootText: '',
        uiDirection: 'rtl',
      }).rootDirection,
    ).toBe('rtl');

    expect(
      planEditorDirection({
        blockDirections: [],
        rootDirection: null,
        rootText: '123 ...',
        uiDirection: 'rtl',
      }).rootDirection,
    ).toBe('rtl');

    expect(
      planEditorDirection({
        blockDirections: [],
        rootDirection: null,
        rootText: '',
        uiDirection: 'ltr',
      }).rootDirection,
    ).toBe('ltr');
  });

  it('lets the text win over the UI language', () => {
    // Persian text in an English UI, and English text in a Persian UI.
    expect(
      planEditorDirection({
        blockDirections: [],
        rootDirection: null,
        rootText: 'سلام',
        uiDirection: 'ltr',
      }).rootDirection,
    ).toBe('rtl');

    expect(
      planEditorDirection({
        blockDirections: [],
        rootDirection: null,
        rootText: 'Hello',
        uiDirection: 'rtl',
      }).rootDirection,
    ).toBe('ltr');
  });
});
