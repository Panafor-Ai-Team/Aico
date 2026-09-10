import { useLexicalComposerContext } from '@lobehub/editor';
import {
  $getRoot,
  $isElementNode,
  type ElementNode,
  type LexicalEditor,
  ParagraphNode,
  TextNode,
} from 'lexical';
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
 * The rule runs as a node transform rather than an update listener on purpose.
 * An update listener fires *after* Lexical has reconciled the DOM, so the
 * direction always described the previous keystroke: the first character typed
 * rendered with the old direction and only snapped into place on the second. A
 * production build shows that lag plainly; a dev build usually repaints fast
 * enough to hide it. Transforms run inside the same update, before
 * reconciliation, so the very first character lands in the right place.
 *
 * Wiring matters as much as the rule: the inner Lexical editor is created
 * asynchronously (`setRootElement`, in another component's effect), so
 * `getLexicalEditor()` is still null when this effect first runs. Bailing out
 * then would silently disable the plugin forever — hence the `initialized`
 * subscription.
 */
const ReactAutoDirectionPlugin: FC = () => {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    let teardowns: (() => void)[] = [];

    const attach = (lexicalEditor: LexicalEditor) => {
      teardowns.forEach((teardown) => teardown());

      const sync = () => $syncRootDirection(getDocumentDirection());

      // Text edits dirty the TextNode; clearing the input (or first mount)
      // dirties the paragraph, which is the only node left when there is no
      // text. Programmatic swaps (draft restore, `setDocument`) dirty the nodes
      // they insert, so they run through the same transforms.
      teardowns = [
        lexicalEditor.registerNodeTransform(TextNode, sync),
        lexicalEditor.registerNodeTransform(ParagraphNode, sync),
      ];

      // Content applied before this point (initialContent, migrated home
      // fallback value) dirtied nothing, so no transform would see it — give it
      // the right side up front instead of waiting for the next keystroke.
      lexicalEditor.update(sync);
    };

    const ready = editor.getLexicalEditor();
    if (ready) {
      attach(ready);
    } else {
      editor.once('initialized', attach);
    }

    return () => {
      // `once` auto-removes after firing; `off` is a no-op if it never did.
      editor.off('initialized', attach);
      teardowns.forEach((teardown) => teardown());
    };
  }, [editor]);

  return null;
};

ReactAutoDirectionPlugin.displayName = 'ReactAutoDirectionPlugin';

export default ReactAutoDirectionPlugin;
