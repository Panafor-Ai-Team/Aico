import { type DocumentRenderModeFields, getDocumentRenderMode } from './documentRenderMode';

/**
 * How a stored document is previewed and downloaded. Derived only from the
 * stored metadata (filename extension, file type, category, source type) — never
 * from a user-editable picker — so every document keeps its original format.
 */
export type DocumentPreviewKind = 'code' | 'html' | 'markdown';

export interface DocumentFileFormat {
  /** Lower-case extension without the dot, e.g. `md`, `html`. */
  extension: string;
  /** Safe download filename including the extension. */
  filename: string;
  /** Code language for highlighted views (`markdown` for rich documents). */
  language: string;
  /** MIME type (with charset) for the downloaded Blob. */
  mimeType: string;
  previewKind: DocumentPreviewKind;
}

const FALLBACK_BASENAME = 'document';

const MIME_BY_EXTENSION: Record<string, string> = {
  css: 'text/css',
  csv: 'text/csv',
  htm: 'text/html',
  html: 'text/html',
  js: 'text/javascript',
  json: 'application/json',
  markdown: 'text/markdown',
  md: 'text/markdown',
  mdx: 'text/markdown',
  mjs: 'text/javascript',
  svg: 'image/svg+xml',
  tsv: 'text/tab-separated-values',
  xml: 'application/xml',
  yaml: 'application/yaml',
  yml: 'application/yaml',
};

const MARKDOWN_EXTENSIONS = new Set(['markdown', 'md', 'mdx']);

// Characters that are invalid in filenames on Windows/macOS/Linux.
// eslint-disable-next-line no-control-regex
const UNSAFE_FILENAME_CHARS = /[\u0000-\u001F"*/:<>?\\|]/g;

const sanitizeFilename = (name: string) => name.replaceAll(UNSAFE_FILENAME_CHARS, '-').trim();

const getExtension = (filename: string): string | undefined =>
  /\.([\dA-Z]{1,10})$/i.exec(filename)?.[1]?.toLowerCase();

const withCharset = (mimeType: string) =>
  mimeType.startsWith('text/') || mimeType.endsWith('json') || mimeType.endsWith('xml')
    ? `${mimeType};charset=utf-8`
    : mimeType;

export const getDocumentFileFormat = (document: DocumentRenderModeFields): DocumentFileFormat => {
  const basename = sanitizeFilename(document.filename || document.title || '') || FALLBACK_BASENAME;
  const renderMode = getDocumentRenderMode(document);

  // Rich editor documents (agent documents, notes, skills, *.md) store Markdown.
  if (renderMode.mode === 'editor') {
    const extension = getExtension(basename);
    const hasMarkdownExtension = !!extension && MARKDOWN_EXTENSIONS.has(extension);

    return {
      extension: hasMarkdownExtension ? extension : 'md',
      filename: hasMarkdownExtension ? basename : `${basename}.md`,
      language: 'markdown',
      mimeType: withCharset('text/markdown'),
      previewKind: 'markdown',
    };
  }

  const extension = getExtension(basename) ?? 'txt';

  return {
    extension,
    filename: basename,
    language: renderMode.language,
    mimeType: withCharset(MIME_BY_EXTENSION[extension] ?? 'text/plain'),
    previewKind: renderMode.language === 'html' ? 'html' : 'code',
  };
};
