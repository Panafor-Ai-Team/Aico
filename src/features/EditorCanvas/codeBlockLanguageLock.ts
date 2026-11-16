import type { LexicalEditor, LexicalNode } from 'lexical';
import type { ReactNode } from 'react';

/** Decorator name `CodemirrorPlugin` (@lobehub/editor) registers its code-block UI under. */
export const CODEMIRROR_DECORATOR = 'codemirror';

/** Class of the stock language dropdown in the @lobehub/editor code-block toolbar. */
export const LANGUAGE_SELECT_SELECTOR = '.cm-language-select';

export type DecoratorFunc = (node: LexicalNode, editor: LexicalEditor) => ReactNode;
export type Decorator = DecoratorFunc | { render: DecoratorFunc };

/** The subset of the @lobehub/editor kernel plugin API the lock relies on. */
export interface DecoratorKernel {
  getDecorator: (name: string) => Decorator | undefined;
  registerDecorator: (name: string, decorator: Decorator) => void;
  unregisterDecorator: (name: string) => boolean;
}

export interface CodeMirrorNodeLike {
  readonly code?: string;
  getKey: () => string;
}

const WRAPPED = Symbol('codeBlockLanguageLock');

/**
 * Remembers, per code-block node, whether its language is locked. The decision
 * is made the first time a block is seen: a block that already holds code
 * (loaded from the saved document or written by the agent) keeps its language;
 * a block created empty in this session stays free to pick one.
 */
export class CodeBlockLockRegistry {
  private readonly lockedByKey = new Map<string, boolean>();

  isLocked(node: CodeMirrorNodeLike): boolean {
    const key = node.getKey();
    let locked = this.lockedByKey.get(key);
    if (locked === undefined) {
      locked = !!node.code?.trim();
      this.lockedByKey.set(key, locked);
    }
    return locked;
  }

  clear() {
    this.lockedByKey.clear();
  }
}

/**
 * Replaces the stock code-block decorator with `wrap(node, stockElement)`.
 * Idempotent, and a no-op when the code-block plugin is not registered.
 */
export const wrapCodeMirrorDecorator = (
  kernel: DecoratorKernel,
  wrap: (node: LexicalNode, rendered: ReactNode) => ReactNode,
): boolean => {
  const original = kernel.getDecorator(CODEMIRROR_DECORATOR);
  if (!original || (original as { [WRAPPED]?: true })[WRAPPED]) return false;

  const render: DecoratorFunc =
    typeof original === 'function' ? original : (node, editor) => original.render(node, editor);

  const wrapped: DecoratorFunc & { [WRAPPED]?: true } = (node, editor) =>
    wrap(node, render(node, editor));
  wrapped[WRAPPED] = true;

  kernel.unregisterDecorator(CODEMIRROR_DECORATOR);
  kernel.registerDecorator(CODEMIRROR_DECORATOR, wrapped);
  return true;
};

/**
 * Makes the stock language dropdown inside `container` unreachable (`inert`:
 * no pointer and no keyboard access) while `locked`, so a saved block's format
 * cannot be switched by a stray click.
 */
export const setLanguagePickerLocked = (container: ParentNode | null, locked: boolean) => {
  container?.querySelector<HTMLElement>(LANGUAGE_SELECT_SELECTOR)?.toggleAttribute('inert', locked);
};
