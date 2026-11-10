import { isFullHtmlDocument } from '@lobehub/ui';

const HTML_LANGS = new Set(['html', 'htm', 'xhtml']);

/** Fence langs models often use when they forget to tag HTML. */
const AMBIGUOUS_LANGS = new Set(['', 'plaintext', 'text', 'txt', 'output', 'raw', 'code']);

const STRUCTURAL_TAG_RE =
  /<(?:html|head|body|div|section|main|header|footer|nav|article|aside|style|script|table|form|button|input|textarea|select|svg|canvas|iframe|template)\b/i;

const TAG_RE = /<\/?[a-z][^>]*>/gi;

export const normalizeCodeFenceLang = (lang?: string | null): string =>
  (lang || '')
    .trim()
    .toLowerCase()
    .replace(/^language-/, '');

export const isHtmlCodeFenceLang = (lang?: string | null): boolean =>
  HTML_LANGS.has(normalizeCodeFenceLang(lang));

export const isAmbiguousCodeFenceLang = (lang?: string | null): boolean =>
  AMBIGUOUS_LANGS.has(normalizeCodeFenceLang(lang));

/**
 * True when content looks like HTML markup worth previewing (full document or
 * a multi-tag structural fragment). Kept conservative for untagged fences so
 * we don't iframe random XML / JSX pasted as plaintext.
 */
export const looksLikeHtmlMarkup = (content?: string | null): boolean => {
  if (!content) return false;

  const trimmed = content.trim();
  if (!trimmed) return false;

  if (isFullHtmlDocument(trimmed)) return true;

  if (trimmed.length < 40) return false;

  const head = trimmed.slice(0, 2048);
  if (!STRUCTURAL_TAG_RE.test(head)) return false;

  const tagCount = head.match(TAG_RE)?.length ?? 0;
  return tagCount >= 2;
};

/**
 * Whether a markdown code fence should mount the interactive HTML preview.
 * Explicit `html`/`htm` always qualify when markup is present; ambiguous langs
 * only when the body is clearly an HTML document or rich fragment.
 */
export const shouldPreviewHtmlCodeBlock = (
  lang: string | null | undefined,
  content: string | null | undefined,
): boolean => {
  if (!content?.trim()) return false;

  if (isHtmlCodeFenceLang(lang)) return looksLikeHtmlMarkup(content);

  if (isAmbiguousCodeFenceLang(lang)) {
    // Untagged / plaintext: only promote clear HTML documents so we don't
    // steal ordinary prose fences that happen to mention a tag.
    return isFullHtmlDocument(content);
  }

  return false;
};

/**
 * HtmlPreview forces fragments into source-only mode. Wrap them in a minimal
 * document shell so iframe preview works for ```html snippets.
 */
export const ensurePreviewableHtmlDocument = (content: string): string => {
  const trimmed = content.trim();
  if (!trimmed) return trimmed;
  if (isFullHtmlDocument(trimmed)) return content;

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>\n${trimmed}\n</body></html>`;
};
