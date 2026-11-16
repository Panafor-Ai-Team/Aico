import { MARKDOWN_MIME_TYPES } from '@lobechat/const';

const PDF_FILE_EXTENSIONS = ['.pdf'];
const PDF_FILE_TYPES = new Set(['pdf', 'application/pdf', 'application/x-pdf']);

const normalizeFileType = (fileType?: string | null) =>
  fileType?.split(';')[0].trim().toLowerCase();

// Signed storage URLs carry `?X-Amz-...` query strings; strip query and fragment
// before extension matching so `.pdf?...` still resolves to `.pdf`.
const stripUrlSuffix = (candidate: string) => candidate.split(/[?#]/)[0];

interface PdfFileFields {
  fileName?: string | null;
  fileType?: string | null;
  path?: string | null;
}

export const isPdfFile = ({ fileName, fileType, path }: PdfFileFields): boolean => {
  const normalizedFileType = normalizeFileType(fileType);

  if (normalizedFileType && PDF_FILE_TYPES.has(normalizedFileType)) return true;

  const candidates = [fileName, path].flatMap((candidate) =>
    candidate ? [stripUrlSuffix(candidate).toLowerCase()] : [],
  );

  if (candidates.length === 0) return false;

  return candidates.some((candidate) =>
    PDF_FILE_EXTENSIONS.some((extension) => candidate.endsWith(extension)),
  );
};

// Markdown renders as rich text. Matched by extension as well as MIME: uploads
// and sandbox exports often store `.md` files as `application/octet-stream`.
const MARKDOWN_FILE_EXTENSIONS = ['.md', '.mdx', '.markdown'];
const MARKDOWN_FILE_TYPES = new Set(['md', 'mdx', 'markdown', ...MARKDOWN_MIME_TYPES]);

interface MarkdownFileFields {
  fileName?: string | null;
  fileType?: string | null;
}

export const isMarkdownFile = ({ fileName, fileType }: MarkdownFileFields): boolean => {
  const normalizedFileType = normalizeFileType(fileType);

  if (normalizedFileType && MARKDOWN_FILE_TYPES.has(normalizedFileType)) return true;
  if (!fileName) return false;

  const candidate = fileName.toLowerCase();
  return MARKDOWN_FILE_EXTENSIONS.some((extension) => candidate.endsWith(extension));
};
