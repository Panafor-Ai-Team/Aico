'use client';

import { useLexicalComposerContext } from '@lobehub/editor';
import { createStaticStyles } from 'antd-style';
import { type FC, type ReactNode, useLayoutEffect, useRef } from 'react';

import {
  CodeBlockLockRegistry,
  type CodeMirrorNodeLike,
  type DecoratorKernel,
  setLanguagePickerLocked,
  wrapCodeMirrorDecorator,
} from './codeBlockLanguageLock';

const styles = createStaticStyles(({ css }) => ({
  frame: css`
    /* Code is always left-to-right, even inside RTL documents (fa-IR). */
    .cm-container {
      direction: ltr;
      unicode-bidi: isolate;
      text-align: start;
    }

    &[data-format-locked='true'] .cm-language-select {
      cursor: default;

      /* Hide the dropdown chevron: the language is a label, not a choice. */
      .ant-select-arrow,
      .ant-select-suffix {
        display: none;
      }
    }
  `,
}));

interface CodeBlockFrameProps {
  children: ReactNode;
  locked: boolean;
}

/** Wraps the stock code block: LTR code, and an inert language picker when locked. */
const CodeBlockFrame = ({ children, locked }: CodeBlockFrameProps) => {
  const ref = useRef<HTMLDivElement>(null);

  // No deps: the stock block re-renders its own subtree, re-apply every commit.
  useLayoutEffect(() => {
    setLanguagePickerLocked(ref.current, locked);
  });

  return (
    <div className={styles.frame} data-format-locked={locked} ref={ref}>
      {children}
    </div>
  );
};

/**
 * Kernel plugin that decorates every CodeMirror code block in document editors:
 * code renders LTR regardless of the page direction, and a block that already
 * held code when first seen keeps its language (see `CodeBlockLockRegistry`).
 */
export class CodeBlockFormatLockPlugin {
  static readonly pluginName = 'CodeBlockFormatLockPlugin';

  private readonly kernel: DecoratorKernel;
  private readonly registry = new CodeBlockLockRegistry();

  constructor(kernel: DecoratorKernel) {
    this.kernel = kernel;
  }

  // Runs after every plugin constructor, so the stock decorator is registered.
  onInit() {
    wrapCodeMirrorDecorator(this.kernel, (node, rendered) => (
      <CodeBlockFrame locked={this.registry.isLocked(node as unknown as CodeMirrorNodeLike)}>
        {rendered}
      </CodeBlockFrame>
    ));
  }

  destroy() {
    this.registry.clear();
  }
}

const ReactCodeBlockFormatLockPlugin: FC = () => {
  const [editor] = useLexicalComposerContext();

  useLayoutEffect(() => {
    editor.registerPlugin(CodeBlockFormatLockPlugin);
  }, [editor]);

  return null;
};

ReactCodeBlockFormatLockPlugin.displayName = 'ReactCodeBlockFormatLockPlugin';

export default ReactCodeBlockFormatLockPlugin;
