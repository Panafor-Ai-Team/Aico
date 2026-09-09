import { useLexicalComposerContext } from '@lobehub/editor';
import type { LexicalEditor } from 'lexical';
import { type FC, useEffect } from 'react';

import { AUTO_DIR_TAG, reconcileEditorDirection } from './reconcileEditorDirection';

/**
 * Keeps every top-level block's Lexical direction on its own first strong
 * character (per-block first-strong, matching `unicode-bidi: plaintext` in
 * CSS), and the root directionless — also clears the forced root `ltr` from
 * @lobehub/editor inode defaults. See `./reconcileEditorDirection` for the rule.
 *
 * Wiring matters more than the rule here: the inner Lexical editor is created
 * asynchronously (`setRootElement`, in another component's effect), so
 * `getLexicalEditor()` is still null when this effect first runs. Attaching
 * only when it is non-null would silently disable the plugin forever — every
 * imported paragraph would keep the inode `ltr` default whatever language it
 * starts with. Hence the `initialized` subscription below.
 */
const ReactAutoDirectionPlugin: FC = () => {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    let detachUpdateListener: (() => void) | undefined;

    const attach = (lexicalEditor: LexicalEditor) => {
      // Content applied before this point (initialContent, migrated home
      // fallback value) never passed the listener — fix it up front so it
      // does not wait for the next keystroke.
      reconcileEditorDirection(lexicalEditor);
      detachUpdateListener?.();
      detachUpdateListener = lexicalEditor.registerUpdateListener(({ tags }) => {
        if (tags.has(AUTO_DIR_TAG)) return;

        reconcileEditorDirection(lexicalEditor);
      });
    };

    const ready = editor.getLexicalEditor();
    if (ready) {
      attach(ready);
    } else {
      editor.once('initialized', attach);
    }

    // Programmatic content swaps (draft restore, saved state) go through
    // `setDocument`, which must not depend on update-listener timing to end
    // up with the right direction.
    const handleDocumentChange = () => {
      const lexicalEditor = editor.getLexicalEditor();
      if (lexicalEditor) reconcileEditorDirection(lexicalEditor);
    };
    editor.on('documentChange', handleDocumentChange);

    return () => {
      // `once` auto-removes after firing; `off` is a no-op if it never did.
      editor.off('initialized', attach);
      editor.off('documentChange', handleDocumentChange);
      detachUpdateListener?.();
    };
  }, [editor]);

  return null;
};

ReactAutoDirectionPlugin.displayName = 'ReactAutoDirectionPlugin';

export default ReactAutoDirectionPlugin;
