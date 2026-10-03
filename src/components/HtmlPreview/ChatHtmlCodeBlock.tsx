'use client';

import { Highlighter, HtmlPreview, Mermaid, Snippet } from '@lobehub/ui';
import { createStaticStyles, cx } from 'antd-style';
import { type CSSProperties, memo, type ReactElement, useMemo } from 'react';

import { ensurePreviewableHtmlDocument, shouldPreviewHtmlCodeBlock } from './detectHtml';

const styles = createStaticStyles(({ css }) => ({
  container: css`
    overflow: hidden;
    margin-block: calc(var(--lobe-markdown-margin-multiple) * 0.5em);
    border-radius: calc(var(--lobe-markdown-border-radius) * 1px);
    box-shadow: 0 0 0 1px var(--lobe-markdown-border-color) inset;
  `,
}));

const countLines = (str: string) => {
  const matches = str.match(/\n/g);
  return matches ? matches.length : 1;
};

const parseCodeFence = (raw: ReactElement | undefined) => {
  if (!raw) return;

  const { children = '', className } = (raw.props || { children: '' }) as {
    children?: string | string[];
    className?: string;
  };

  if (!children) return;

  const content = Array.isArray(children) ? children[0] : children;
  if (typeof content !== 'string' || !content) return;

  const lang = className?.replace('language-', '') || 'plaintext';

  return {
    content,
    isSingleLine: countLines(content) <= 1 && content.length <= 32,
    lang,
  };
};

export interface ChatHtmlCodeBlockProps {
  animated?: boolean;
  children?: ReactElement;
  className?: string;
  enableHtmlPreview?: boolean;
  enableMermaid?: boolean;
  fullFeatured?: boolean;
  html?: {
    defaultHeight?: number;
    onExpand?: (content: string) => void;
    streamingMode?: 'auto' | 'defer' | 'live';
  };
  mermaid?: Record<string, unknown>;
  style?: CSSProperties;
}

/**
 * Chat markdown `pre` override. Same shape as @lobehub/ui CodeBlock, but:
 * - previews untagged / plaintext fences that are full HTML documents
 * - wraps ```html fragments so HtmlPreview can iframe them (upstream leaves
 *   fragments stuck in source-only mode)
 */
const ChatHtmlCodeBlock = memo<ChatHtmlCodeBlockProps>(
  ({
    animated,
    children,
    className,
    enableHtmlPreview = true,
    enableMermaid = true,
    fullFeatured,
    html,
    mermaid,
    style,
    ...rest
  }) => {
    const code = parseCodeFence(children);

    const previewContent = useMemo(() => {
      if (!code) return;
      if (!enableHtmlPreview || !shouldPreviewHtmlCodeBlock(code.lang, code.content)) return;
      return ensurePreviewableHtmlDocument(code.content);
    }, [code, enableHtmlPreview]);

    if (!code) return null;

    if (enableMermaid && code.lang === 'mermaid') {
      return (
        <Mermaid
          animated={animated}
          className={cx(styles.container, className)}
          fullFeatured={fullFeatured}
          style={style}
          variant="filled"
          {...mermaid}
          {...rest}
        >
          {code.content}
        </Mermaid>
      );
    }

    if (previewContent) {
      return (
        <HtmlPreview
          animated={animated}
          className={cx(styles.container, className)}
          defaultHeight={html?.defaultHeight ?? 420}
          defaultMode="preview"
          streamingMode={html?.streamingMode ?? 'auto'}
          style={style}
          variant="filled"
          onExpand={html?.onExpand}
          {...rest}
        >
          {previewContent}
        </HtmlPreview>
      );
    }

    if (!fullFeatured && code.isSingleLine) {
      return (
        <Snippet
          className={cx(styles.container, className)}
          data-code-type="highlighter"
          language={code.lang}
          style={style}
          variant="filled"
          {...rest}
        >
          {code.content}
        </Snippet>
      );
    }

    return (
      <Highlighter
        animated={animated}
        className={cx(styles.container, className)}
        fullFeatured={fullFeatured}
        language={code.lang}
        style={style}
        variant="filled"
        {...rest}
      >
        {code.content}
      </Highlighter>
    );
  },
);

ChatHtmlCodeBlock.displayName = 'ChatHtmlCodeBlock';

export default ChatHtmlCodeBlock;
