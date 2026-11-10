/**
 * @vitest-environment happy-dom
 */
import { act, cleanup, render } from '@testing-library/react';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  createEditor,
  type LexicalEditor,
  ParagraphNode,
  TextNode,
} from 'lexical';
import { afterEach, describe, expect, it, vi } from 'vitest';

import ReactAutoDirectionPlugin from './ReactAutoDirectionPlugin';

const captured = vi.hoisted(() => ({ handlers: {} as Record<string, (...args: any[]) => void> }));

const mockEditor = vi.hoisted(() => ({
  getLexicalEditor: vi.fn<() => LexicalEditor | null>(() => null),
  off: vi.fn(),
  on: vi.fn((event: string, handler: (...args: any[]) => void) => {
    captured.handlers[event] = handler;
  }),
  once: vi.fn((event: string, handler: (...args: any[]) => void) => {
    captured.handlers[event] = handler;
  }),
}));

vi.mock('@lobehub/editor', () => ({
  useLexicalComposerContext: () => [mockEditor],
}));

const createPersianEditor = (): LexicalEditor => {
  const editor = createEditor({
    nodes: [ParagraphNode, TextNode],
    onError: (error) => {
      throw error;
    },
  });
  // Persian content carrying the inode `ltr` default, as the importer leaves it.
  editor.update(
    () => {
      const root = $getRoot();
      root.clear();
      root.setDirection('ltr');
      const paragraph = $createParagraphNode();
      paragraph.setDirection('ltr');
      paragraph.append($createTextNode('سلام دنیا'));
      root.append(paragraph);
    },
    { discrete: true },
  );
  return editor;
};

const readRootAndBlock = (editor: LexicalEditor) =>
  editor.getEditorState().read(() => {
    const root = $getRoot();
    const block = root.getFirstChild() as unknown as {
      getDirection: () => unknown;
    } | null;
    return { block: block?.getDirection() ?? null, root: root.getDirection() };
  });

const flushUpdates = async () => {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  captured.handlers = {};
  mockEditor.getLexicalEditor.mockImplementation(() => null);
});

describe('ReactAutoDirectionPlugin', () => {
  it('attaches on initialized when the inner editor is not ready at mount', async () => {
    render(<ReactAutoDirectionPlugin />);

    // The inner editor is created later (setRootElement in another effect),
    // so the plugin must wait instead of giving up.
    expect(mockEditor.once).toHaveBeenCalledWith('initialized', expect.any(Function));

    const lexicalEditor = createPersianEditor();
    mockEditor.getLexicalEditor.mockImplementation(() => lexicalEditor);

    await act(async () => {
      captured.handlers['initialized'](lexicalEditor);
      await flushUpdates();
    });

    expect(readRootAndBlock(lexicalEditor)).toEqual({ block: 'rtl', root: null });
  });

  it('attaches immediately when the inner editor already exists', async () => {
    const lexicalEditor = createPersianEditor();
    mockEditor.getLexicalEditor.mockImplementation(() => lexicalEditor);

    render(<ReactAutoDirectionPlugin />);
    await act(async () => {
      await flushUpdates();
    });

    expect(mockEditor.once).not.toHaveBeenCalled();
    expect(readRootAndBlock(lexicalEditor)).toEqual({ block: 'rtl', root: null });
  });

  it('re-reconciles on programmatic content swaps', async () => {
    const lexicalEditor = createPersianEditor();
    mockEditor.getLexicalEditor.mockImplementation(() => lexicalEditor);

    render(<ReactAutoDirectionPlugin />);
    await act(async () => {
      await flushUpdates();
    });
    expect(mockEditor.on).toHaveBeenCalledWith('documentChange', expect.any(Function));

    // A later setDocument lands with stale directions again…
    lexicalEditor.update(
      () => {
        $getRoot().setDirection('ltr');
      },
      { discrete: true },
    );

    await act(async () => {
      captured.handlers['documentChange']();
      await flushUpdates();
    });

    expect(readRootAndBlock(lexicalEditor).root).toBeNull();
  });
});
