import { useLexicalComposerContext } from '@lobehub/editor';
import { $getRoot, $isElementNode, type ElementNode } from 'lexical';
import { type FC, useEffect } from 'react';

import { getDocumentDirection } from '@/utils/client/applyDocumentDirection';
import { resolveTextDirection, type TextDirection } from '@/utils/textDirection';

const AUTO_DIR_TAG = 'chat-input-auto-direction';

/**
 * The direction the editor should be in, and whether the current tree already
 * matches it. Extracted from the plugin so the rule is testable without a live
 * Lexical editor.
 *
 * The rule: the root carries the direction for the whole text; no block carries
 * one of its own.
 */
export const planEditorDirection = ({
  blockDirections,
  rootDirection,
  rootText,
  uiDirection,
}: {
  blockDirections: TextDirection[];
  rootDirection: TextDirection;
  rootText: string;
  uiDirection: 'ltr' | 'rtl';
}): { needsUpdate: boolean; rootDirection: 'ltr' | 'rtl' } => {
  // Never null: leaving the root unset makes Lexical fall back to `dir="auto"`
  // on each block, and `dir="auto"` on empty text resolves to ltr even in an
  // rtl UI — which is what put the caret on the left in an empty Persian input.
  const next = resolveTextDirection(rootText, uiDirection);

  return {
    needsUpdate: rootDirection !== next || blockDirections.some((dir) => dir !== null),
    rootDirection: next,
  };
};

/**
 * Gives the whole input a single direction, taken from the first strong
 * character of the entire text — the behaviour Telegram and WhatsApp use.
 *
 * This deliberately does NOT set direction per block. Doing so made every line
 * pick its own alignment, so a Persian line and an English line in the same
 * message flew to opposite edges of the composer, and typing a Latin character
 * at the start of a line jumped that line across the box. Per-block directions
 * are cleared so blocks inherit the root instead.
 *
 * The root direction is also what clears the forced `ltr` that
 * \@lobehub/editor's inode defaults put on the root.
 */
const ReactAutoDirectionPlugin: FC = () => {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    const lexicalEditor = editor.getLexicalEditor();
    if (!lexicalEditor) return;

    return lexicalEditor.registerUpdateListener(({ editorState, tags }) => {
      if (tags.has(AUTO_DIR_TAG)) return;

      let needsUpdate = false;

      editorState.read(() => {
        const root = $getRoot();
        needsUpdate = planEditorDirection({
          blockDirections: root
            .getChildren()
            .filter((child) => $isElementNode(child) && !child.isInline())
            .map((child) => (child as ElementNode).getDirection()),
          rootDirection: root.getDirection(),
          rootText: root.getTextContent(),
          uiDirection: getDocumentDirection(),
        }).needsUpdate;
      });

      if (!needsUpdate) return;

      lexicalEditor.update(
        () => {
          const root = $getRoot();
          const { rootDirection: next } = planEditorDirection({
            blockDirections: [],
            rootDirection: root.getDirection(),
            rootText: root.getTextContent(),
            uiDirection: getDocumentDirection(),
          });
          if (root.getDirection() !== next) {
            root.setDirection(next);
          }

          // Blocks inherit the root direction; a per-block direction is what
          // used to split alignment line by line.
          for (const child of root.getChildren()) {
            if (!$isElementNode(child) || child.isInline()) continue;
            if (child.getDirection() !== null) {
              child.setDirection(null);
            }
          }
        },
        { tag: AUTO_DIR_TAG },
      );
    });
  }, [editor]);

  return null;
};

ReactAutoDirectionPlugin.displayName = 'ReactAutoDirectionPlugin';

export default ReactAutoDirectionPlugin;
