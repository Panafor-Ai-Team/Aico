import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isElementNode,
  createEditor,
  type LexicalEditor,
  ParagraphNode,
  TextNode,
} from 'lexical';
import { describe, expect, it } from 'vitest';

import { reconcileEditorDirection } from './reconcileEditorDirection';

const createTestEditor = (): LexicalEditor =>
  createEditor({
    nodes: [ParagraphNode, TextNode],
    onError: (error) => {
      throw error;
    },
  });

/** Set block text the way an importer / draft restore would: no directions fixed. */
const setParagraphs = (editor: LexicalEditor, texts: string[]) => {
  editor.update(
    () => {
      const root = $getRoot();
      root.clear();
      for (const text of texts) {
        const paragraph = $createParagraphNode();
        if (text) paragraph.append($createTextNode(text));
        root.append(paragraph);
      }
    },
    { discrete: true },
  );
};

/** Force every direction to a stale value, simulating a missed update. */
const resetDirections = (
  editor: LexicalEditor,
  rootDir: 'ltr' | 'rtl' | null,
  blockDir: 'ltr' | 'rtl' | null,
) => {
  editor.update(
    () => {
      const root = $getRoot();
      root.setDirection(rootDir);
      for (const child of root.getChildren()) {
        if ($isElementNode(child) && !child.isInline()) child.setDirection(blockDir);
      }
    },
    { discrete: true },
  );
};

const readDirections = (editor: LexicalEditor) =>
  editor.getEditorState().read(() => {
    const root = $getRoot();
    return {
      blocks: root
        .getChildren()
        .filter((child) => $isElementNode(child) && !child.isInline())
        .map((child) => ($isElementNode(child) ? child.getDirection() : null)),
      root: root.getDirection(),
    };
  });

/** Reconcile applies via a regular (non-discrete) update: let it flush. */
const flushUpdates = async () => {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

describe('reconcileEditorDirection', () => {
  it('gives initial English content ltr immediately (no keystroke needed)', async () => {
    const editor = createTestEditor();
    setParagraphs(editor, ['h']);
    resetDirections(editor, null, null);

    expect(reconcileEditorDirection(editor)).toBe(true);
    await flushUpdates();
    expect(readDirections(editor)).toEqual({ blocks: ['ltr'], root: null });
  });

  it('gives initial Persian content rtl immediately', async () => {
    const editor = createTestEditor();
    setParagraphs(editor, ['سلام']);
    resetDirections(editor, null, null);

    expect(reconcileEditorDirection(editor)).toBe(true);
    await flushUpdates();
    expect(readDirections(editor)).toEqual({ blocks: ['rtl'], root: null });
  });

  it('keeps an English-first line ltr when a later word is Persian', async () => {
    const editor = createTestEditor();
    setParagraphs(editor, ['Hello سلام']);
    resetDirections(editor, null, null);

    expect(reconcileEditorDirection(editor)).toBe(true);
    await flushUpdates();
    expect(readDirections(editor)).toEqual({ blocks: ['ltr'], root: null });
  });

  it('keeps per-block directions in multi-paragraph text', async () => {
    const editor = createTestEditor();
    setParagraphs(editor, ['Hello', 'سلام دنیا']);
    resetDirections(editor, null, null);

    expect(reconcileEditorDirection(editor)).toBe(true);
    await flushUpdates();
    expect(readDirections(editor)).toEqual({ blocks: ['ltr', 'rtl'], root: null });
  });

  it('fixes a stale block direction instead of leaving it', async () => {
    const editor = createTestEditor();
    setParagraphs(editor, ['hello']);
    resetDirections(editor, null, 'rtl');

    expect(reconcileEditorDirection(editor)).toBe(true);
    await flushUpdates();
    expect(readDirections(editor).blocks).toEqual(['ltr']);
  });

  it('clears a forced root direction so blocks resolve on their own', async () => {
    const editor = createTestEditor();
    setParagraphs(editor, ['سلام']);
    resetDirections(editor, 'ltr', null);

    expect(reconcileEditorDirection(editor)).toBe(true);
    await flushUpdates();
    expect(readDirections(editor)).toEqual({ blocks: ['rtl'], root: null });
  });

  it('falls back to ltr for empty content on a left-to-right page', async () => {
    const editor = createTestEditor();
    setParagraphs(editor, ['', '123 ...']);
    resetDirections(editor, null, null);

    expect(reconcileEditorDirection(editor)).toBe(true);
    await flushUpdates();
    expect(readDirections(editor)).toEqual({ blocks: ['ltr', 'ltr'], root: null });
  });

  it('aligns empty content to the right on a right-to-left page', async () => {
    document.dir = 'rtl';
    try {
      const editor = createTestEditor();
      setParagraphs(editor, ['']);
      resetDirections(editor, null, null);

      expect(reconcileEditorDirection(editor)).toBe(true);
      await flushUpdates();
      expect(readDirections(editor)).toEqual({ blocks: ['rtl'], root: null });
    } finally {
      document.dir = '';
    }
  });

  it('is a no-op once settled', async () => {
    const editor = createTestEditor();
    setParagraphs(editor, ['Hello سلام']);
    resetDirections(editor, null, null);

    expect(reconcileEditorDirection(editor)).toBe(true);
    await flushUpdates();
    expect(reconcileEditorDirection(editor)).toBe(false);
    await flushUpdates();
    expect(readDirections(editor)).toEqual({ blocks: ['ltr'], root: null });
  });
});
