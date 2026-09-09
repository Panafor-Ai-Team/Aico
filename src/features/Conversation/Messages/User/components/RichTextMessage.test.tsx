/**
 * @vitest-environment happy-dom
 */
import { moment } from '@lobehub/editor';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import RichTextMessage from './RichTextMessage';

const mentionEditorState = {
  root: {
    children: [
      {
        children: [
          {
            label: 'Agent A',
            metadata: { id: 'agent-a', type: 'agent' },
            type: 'mention',
            version: 1,
          },
        ],
        direction: null,
        format: '',
        indent: 0,
        type: 'paragraph',
        version: 1,
      },
    ],
    direction: null,
    format: '',
    indent: 0,
    type: 'root',
    version: 1,
  },
};

/**
 * A message sent before one-direction-per-message shipped: the composer baked a
 * `direction` into each block, so the Persian and English lines carried
 * opposite directions and rendered against opposite edges.
 */
const mixedDirectionEditorState = {
  root: {
    children: [
      {
        children: [
          {
            detail: 0,
            format: 0,
            mode: 'normal',
            style: '',
            text: 'سلام دنیا',
            type: 'text',
            version: 1,
          },
        ],
        direction: 'rtl',
        format: '',
        indent: 0,
        type: 'paragraph',
        version: 1,
      },
      {
        children: [
          {
            detail: 0,
            format: 0,
            mode: 'normal',
            style: '',
            text: 'Hello world',
            type: 'text',
            version: 1,
          },
        ],
        direction: 'ltr',
        format: '',
        indent: 0,
        type: 'paragraph',
        version: 1,
      },
    ],
    direction: 'rtl',
    format: '',
    indent: 0,
    type: 'root',
    version: 1,
  },
};

const localFileEditorState = {
  root: {
    children: [
      {
        children: [
          {
            isDirectory: false,
            name: 'report.md',
            path: '/Users/me/project/report.md',
            type: 'local-file-tag',
            version: 1,
          },
        ],
        direction: null,
        format: '',
        indent: 0,
        type: 'paragraph',
        version: 1,
      },
    ],
    direction: null,
    format: '',
    indent: 0,
    type: 'root',
    version: 1,
  },
};

afterEach(() => {
  cleanup();
});

describe('RichTextMessage', () => {
  it('should render mention nodes from editor state', async () => {
    const { container } = render(<RichTextMessage editorState={mentionEditorState} />);

    await act(async () => {
      await moment();
    });

    expect(container.querySelector('.editor_mention')?.textContent).toBe('@Agent A');
  });

  // Regression: a local file dragged from the working sidebar serializes to a
  // `local-file-tag` node. If that node isn't registered on the renderer,
  // LexicalRenderer throws while parsing the state and the whole message crashes.
  it('should render local-file-tag nodes without crashing', async () => {
    const { container } = render(<RichTextMessage editorState={localFileEditorState} />);

    await act(async () => {
      await moment();
    });

    expect(container.textContent).toContain('report.md');
  });

  // Regression: the renderer used `unicode-bidi: plaintext`, which resolves
  // direction per line. A Persian line and an English line in one message then
  // aligned to opposite edges, and the composer jumped as soon as a line began
  // with a Latin character. The whole message must take one direction from its
  // first strong character instead.
  it('gives a mixed Persian/English message a single rtl direction', async () => {
    const { container } = render(<RichTextMessage editorState={mixedDirectionEditorState} />);

    await act(async () => {
      await moment();
    });

    const root = container.firstElementChild as HTMLElement;
    expect(root.style.direction).toBe('rtl');
    expect(root.style.unicodeBidi).toBe('');
  });

  it('takes ltr from an English-first message', async () => {
    const englishFirst = {
      root: {
        ...mixedDirectionEditorState.root,
        children: [...mixedDirectionEditorState.root.children].reverse(),
      },
    };
    const { container } = render(<RichTextMessage editorState={englishFirst} />);

    await act(async () => {
      await moment();
    });

    expect((container.firstElementChild as HTMLElement).style.direction).toBe('ltr');
  });

  it('should render nothing for empty editor state', () => {
    const { container } = render(<RichTextMessage editorState={{}} />);

    expect(container).toBeEmptyDOMElement();
  });
});
