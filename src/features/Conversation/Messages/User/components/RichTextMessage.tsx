import { LexicalRenderer } from '@lobehub/editor/renderer';
import { css, cx } from 'antd-style';
import type { SerializedEditorState } from 'lexical';
import type { CSSProperties } from 'react';
import { memo, useMemo } from 'react';

import { ActionTagNode } from '@/features/ChatInput/InputEditor/ActionTag/ActionTagNode';
import { LocalFileTagNode } from '@/features/ChatInput/InputEditor/LocalFileTag';
import { mentionFilledClassName } from '@/features/ChatInput/InputEditor/mentionStyle';
import { ReferTopicNode } from '@/features/ChatInput/InputEditor/ReferTopic/ReferTopicNode';
import { getTextDirectionFromFirstStrong } from '@/utils/textDirection';

interface RichTextMessageProps {
  editorState: unknown;
}

const LINE_HEIGHT = 1.6;
const EXTRA_NODES = [ActionTagNode, ReferTopicNode, LocalFileTagNode];

/**
 * Messages sent before one-direction-per-message shipped have a `direction`
 * baked into each serialized block, which Lexical renders as a per-paragraph
 * `dir`. Without this they keep splitting alignment line by line.
 */
const oneDirectionClassName = css`
  [dir] {
    direction: inherit;
  }
`;

/** Concatenate the text of a serialized Lexical tree, depth-first. */
const collectText = (node: unknown): string => {
  if (!node || typeof node !== 'object') return '';
  const { children, text } = node as { children?: unknown[]; text?: unknown };
  if (typeof text === 'string') return text;
  if (!Array.isArray(children)) return '';
  return children.map((child) => collectText(child)).join(' ');
};

const RichTextMessage = memo<RichTextMessageProps>(({ editorState }) => {
  const value = useMemo(() => {
    if (!editorState || typeof editorState !== 'object') return null;
    if (Object.keys(editorState as Record<string, unknown>).length === 0) return null;
    return editorState as SerializedEditorState;
  }, [editorState]);

  // One direction for the whole message, from its first strong character —
  // matches the composer, so what you typed is what you see once sent.
  const style = useMemo(
    () =>
      ({
        '--common-line-height': LINE_HEIGHT,
        'direction':
          (value && getTextDirectionFromFirstStrong(collectText(value.root))) || undefined,
      }) as CSSProperties,
    [value],
  );

  if (!value) return null;

  return (
    <LexicalRenderer
      className={cx(mentionFilledClassName, oneDirectionClassName)}
      extraNodes={EXTRA_NODES}
      style={style}
      value={value}
      variant="chat"
    />
  );
});

RichTextMessage.displayName = 'RichTextMessage';

export default RichTextMessage;
