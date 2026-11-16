/**
 * @vitest-environment happy-dom
 */
import type { LexicalEditor, LexicalNode } from 'lexical';
import { describe, expect, it, vi } from 'vitest';

import {
  CodeBlockLockRegistry,
  CODEMIRROR_DECORATOR,
  type Decorator,
  type DecoratorFunc,
  type DecoratorKernel,
  setLanguagePickerLocked,
  wrapCodeMirrorDecorator,
} from './codeBlockLanguageLock';

const createKernel = (initial: Decorator | null) => {
  const decorators = new Map<string, Decorator>();
  if (initial) decorators.set(CODEMIRROR_DECORATOR, initial);

  const kernel: DecoratorKernel = {
    getDecorator: (name) => decorators.get(name),
    registerDecorator: (name, decorator) => {
      // Mirrors the real kernel: re-registering a name throws.
      if (decorators.has(name)) throw new Error(`Decorator "${name}" already registered`);
      decorators.set(name, decorator);
    },
    unregisterDecorator: (name) => decorators.delete(name),
  };

  return { decorators, kernel };
};

const codeNode = (key: string, code: string) => ({ code, getKey: () => key });

const callDecorator = (kernel: DecoratorKernel, node: unknown) =>
  (kernel.getDecorator(CODEMIRROR_DECORATOR) as DecoratorFunc)(
    node as LexicalNode,
    {} as LexicalEditor,
  );

describe('CodeBlockLockRegistry', () => {
  it('locks a block that already holds code when first seen (saved / agent-written)', () => {
    // Production case: the "Game Landing Page" CSS block whose language was
    // switched to YAML with one click from the stock dropdown.
    expect(new CodeBlockLockRegistry().isLocked(codeNode('1', 'body { color: white; }'))).toBe(
      true,
    );
  });

  it('keeps a block created empty in this session unlocked, even after code is typed', () => {
    const registry = new CodeBlockLockRegistry();

    expect(registry.isLocked(codeNode('2', ''))).toBe(false);
    expect(registry.isLocked(codeNode('2', 'console.log(1)'))).toBe(false);
  });

  it('treats whitespace-only blocks as empty and forgets decisions on clear()', () => {
    const registry = new CodeBlockLockRegistry();
    expect(registry.isLocked(codeNode('3', '  \n'))).toBe(false);

    registry.clear();
    expect(registry.isLocked(codeNode('3', 'x = 1'))).toBe(true);
  });
});

describe('wrapCodeMirrorDecorator', () => {
  it('wraps the stock function decorator and passes its output through', () => {
    const stock = vi.fn(() => 'stock-block');
    const { kernel } = createKernel(stock);

    expect(wrapCodeMirrorDecorator(kernel, (node, rendered) => ({ node, rendered }))).toBe(true);

    const node = codeNode('1', 'a');
    expect(callDecorator(kernel, node)).toEqual({ node, rendered: 'stock-block' });
    expect(stock).toHaveBeenCalledWith(node, {});
  });

  it('supports object-style decorators ({ render })', () => {
    const { kernel } = createKernel({ render: () => 'rendered' });
    wrapCodeMirrorDecorator(kernel, (_node, rendered) => `wrapped:${rendered}`);

    expect(callDecorator(kernel, codeNode('1', 'a'))).toBe('wrapped:rendered');
  });

  it('wraps only once and is a no-op without the code-block plugin', () => {
    const { kernel } = createKernel(() => 'stock');
    wrapCodeMirrorDecorator(kernel, (_n, r) => r);
    const wrapped = kernel.getDecorator(CODEMIRROR_DECORATOR);

    expect(wrapCodeMirrorDecorator(kernel, (_n, r) => r)).toBe(false);
    expect(kernel.getDecorator(CODEMIRROR_DECORATOR)).toBe(wrapped);

    const empty = createKernel(null);
    expect(wrapCodeMirrorDecorator(empty.kernel, (_n, r) => r)).toBe(false);
    expect(empty.decorators.size).toBe(0);
  });
});

describe('setLanguagePickerLocked', () => {
  const createBlock = () => {
    const container = document.createElement('div');
    container.innerHTML = '<div class="cm-language-select"><button>YAML</button></div>';
    return container;
  };

  it('makes the language dropdown inert (no pointer or keyboard access) when locked', () => {
    const container = createBlock();

    setLanguagePickerLocked(container, true);
    expect(container.querySelector('.cm-language-select')?.hasAttribute('inert')).toBe(true);

    setLanguagePickerLocked(container, false);
    expect(container.querySelector('.cm-language-select')?.hasAttribute('inert')).toBe(false);
  });

  it('ignores a missing container or picker', () => {
    expect(() => setLanguagePickerLocked(null, true)).not.toThrow();
    expect(() => setLanguagePickerLocked(document.createElement('div'), true)).not.toThrow();
  });
});
