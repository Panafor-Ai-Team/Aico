import { useLexicalComposerContext } from '@lobehub/editor';
import { $getRoot, $isElementNode, type ElementNode, ParagraphNode, TextNode } from 'lexical';
import { type FC, useEffect } from 'react';

import { getDocumentDirection } from '@/utils/client/applyDocumentDirection';
import { resolveTextDirection, type TextDirection } from '@/utils/textDirection';

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

/** Applies {@link planEditorDirection} to the live tree. Must run inside an update. */
const $syncRootDirection = (uiDirection: 'ltr' | 'rtl') => {
  const root = $getRoot();
  const blocks = root
    .getChildren()
    .filter((child): child is ElementNode => $isElementNode(child) && !child.isInline());

  const plan = planEditorDirection({
    blockDirections: blocks.map((block) => block.getDirection()),
    rootDirection: root.getDirection(),
    rootText: root.getTextContent(),
    uiDirection,
  });

  if (!plan.needsUpdate) return;

  if (root.getDirection() !== plan.rootDirection) {
    root.setDirection(plan.rootDirection);
  }

  // Blocks inherit the root direction; a per-block direction is what used to
  // split alignment line by line.
  for (const block of blocks) {
    if (block.getDirection() !== null) block.setDirection(null);
  }
};

/**
 * Gives the whole input a single direction, taken from the first strong
 * character of the entire text, falling back to the UI language while the input
 * has no strong character yet — the behaviour Telegram and WhatsApp use.
 *
 * This runs as a node transform rather than an update listener on purpose. An
 * update listener fires *after* Lexical has reconciled the DOM, so the
 * direction always described the previous keystroke: the first character you
 * typed rendered with the old direction and only snapped into place on the
 * second. Transforms run inside the same update, before reconciliation, so the
 * very first character lands in the right place.
 */
const ReactAutoDirectionPlugin: FC = () => {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    const lexicalEditor = editor.getLexicalEditor();
    if (!lexicalEditor) return;

    const sync = () => $syncRootDirection(getDocumentDirection());

    // Text edits dirty the TextNode; clearing the input (or first mount) dirties
    // the paragraph, which is the only node left when there is no text.
    const teardowns = [
      lexicalEditor.registerNodeTransform(TextNode, sync),
      lexicalEditor.registerNodeTransform(ParagraphNode, sync),
    ];

    return () => teardowns.forEach((teardown) => teardown());
  }, [editor]);

  return null;
};

ReactAutoDirectionPlugin.displayName = 'ReactAutoDirectionPlugin';

export default ReactAutoDirectionPlugin;
