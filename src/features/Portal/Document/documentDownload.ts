import { getDocumentFileFormat } from '@/utils/documentFileFormat';
import type { DocumentRenderModeFields } from '@/utils/documentRenderMode';

export interface DocumentDownloadSource extends DocumentRenderModeFields {
  content?: string | null;
}

export interface DocumentDownload {
  content: string;
  extension: string;
  filename: string;
  mimeType: string;
}

/**
 * What to save for a document, in its original format.
 *
 * Rich (Markdown) documents prefer `liveMarkdown` — the document store's copy,
 * synced on every edit (unsaved changes and skill frontmatter included) — and
 * fall back to the stored content. File documents (`.html`, `.css`, …) always
 * use their stored source; a rich-editor entry never replaces it.
 */
export const getDocumentDownload = (
  document: DocumentDownloadSource,
  liveMarkdown?: string,
): DocumentDownload => {
  const { extension, filename, mimeType, previewKind } = getDocumentFileFormat(document);
  const content =
    previewKind === 'markdown' && liveMarkdown ? liveMarkdown : (document.content ?? '');

  return { content, extension, filename, mimeType };
};
