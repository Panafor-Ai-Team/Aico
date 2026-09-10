import { $getRoot, $isElementNode, type LexicalEditor } from 'lexical';

import { getTextDirectionFromFirstStrong } from '@/utils/textDirection';

export const AUTO_DIR_TAG = 'chat-input-auto-direction';

/**
 * Direction for content with no strong character (empty box, digits only).
 * Chrome resolves a directionless empty block to LTR unconditionally, so
 * follow the page instead: an empty composer sits on the UI's side (right in
 * fa-IR) and the first strong character visibly takes over from there.
 * Composer code runs client-side only.
 */
export const getNeutralDirection = (): 'ltr' | 'rtl' =>
  typeof document !== 'undefined' && document.dir === 'rtl' ? 'rtl' : 'ltr';

const getBlockDirection = (text: string): 'ltr' | 'rtl' =>
  getTextDirectionFromFirstStrong(text) ?? getNeutralDirection();

/**
 * Direction system (single rule everywhere): per-block first-strong —
 * `unicode-bidi: plaintext` in CSS. Each paragraph resolves from its own
 * first strong character, so an English-first line stays left even when a
 * later word is Persian, and vice versa.
 *
 * This function is the whole rule, extracted so it can run both on updates
 * and once on mount (and so tests can drive it without a live editor).
 *
 * @returns whether anything was out of date (i.e. an update was applied).
 */
export const reconcileEditorDirection = (lexicalEditor: LexicalEditor): boolean => {
  let needsUpdate = false;

  lexicalEditor.getEditorState().read(() => {
    const root = $getRoot();
    if (root.getDirection() !== null) {
      needsUpdate = true;
      return;
    }

    for (const child of root.getChildren()) {
      if (!$isElementNode(child) || child.isInline()) continue;
      const next = getBlockDirection(child.getTextContent());
      if (child.getDirection() !== next) {
        needsUpdate = true;
        return;
      }
    }
  });

  if (!needsUpdate) return false;

  lexicalEditor.update(
    () => {
      const root = $getRoot();
      if (root.getDirection() !== null) {
        root.setDirection(null);
      }

      for (const child of root.getChildren()) {
        if (!$isElementNode(child) || child.isInline()) continue;
        const next = getBlockDirection(child.getTextContent());
        if (child.getDirection() !== next) {
          child.setDirection(next);
        }
      }
    },
    { tag: AUTO_DIR_TAG },
  );

  return true;
};
