import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  createEditor,
  type ElementNode,
  type LexicalEditor,
} from 'lexical';
import { describe, expect, it } from 'vitest';

import { attachAutoDirection, planEditorDirection } from './ReactAutoDirectionPlugin';

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

/**
 * Regression for the production-only failure: the inner Lexical editor is
 * created asynchronously, so `getLexicalEditor()` is null on the first effect
 * run. The shipped build returned early there and never registered the
 * transforms, leaving the composer with no direction logic at all — React
 * StrictMode masked it in dev by invoking the effect a second time.
 */
describe('attachAutoDirection wiring', () => {
  const makeLexicalEditor = () => {
    const editor = createEditor({
      namespace: 'test',
      onError: (error) => {
        throw error;
      },
    });
    editor.setRootElement(document.createElement('div'));
    editor.update(
      () => {
        const root = $getRoot();
        root.clear();
        root.append($createParagraphNode());
      },
      { discrete: true },
    );
    return editor;
  };

  const typeOneChar = (editor: LexicalEditor, char: string) =>
    editor.update(() => ($getRoot().getFirstChild() as ElementNode).append($createTextNode(char)), {
      discrete: true,
    });

  const readDirection = (editor: LexicalEditor) =>
    editor.getEditorState().read(() => $getRoot().getDirection());

  it('attaches once the editor initializes, not only when it already exists', () => {
    const lexicalEditor = makeLexicalEditor();
    let initialize: ((editor: LexicalEditor) => void) | undefined;

    // The real host: no inner editor yet on the first (and only) effect run.
    attachAutoDirection(
      {
        getLexicalEditor: () => null,
        off: () => {},
        once: (_event, handler) => void (initialize = handler),
      },
      () => 'rtl',
    );

    expect(initialize).toBeDefined();
    initialize!(lexicalEditor);

    typeOneChar(lexicalEditor, 'a');
    expect(readDirection(lexicalEditor)).toBe('ltr');
  });

  it('applies the direction in the same commit as the keystroke', () => {
    const lexicalEditor = makeLexicalEditor();
    attachAutoDirection(
      { getLexicalEditor: () => lexicalEditor, off: () => {}, once: () => {} },
      () => 'rtl',
    );

    const commits: (string | null)[] = [];
    lexicalEditor.registerUpdateListener(({ editorState }) => {
      editorState.read(() => commits.push($getRoot().getDirection()));
    });

    typeOneChar(lexicalEditor, 'a');

    // An update listener would leave the first commit on the old direction and
    // only correct it in a second one — the "snaps over on the second
    // character" bug. A transform lands it inside the same commit.
    expect(commits[0]).toBe('ltr');
  });

  it('gives content that arrived before attach the right side up front', async () => {
    const lexicalEditor = makeLexicalEditor();
    typeOneChar(lexicalEditor, 'س');

    attachAutoDirection(
      { getLexicalEditor: () => lexicalEditor, off: () => {}, once: () => {} },
      () => 'ltr',
    );

    // The catch-up pass is a normal (batched) update; let it commit.
    await Promise.resolve();

    expect(readDirection(lexicalEditor)).toBe('rtl');
  });
});
