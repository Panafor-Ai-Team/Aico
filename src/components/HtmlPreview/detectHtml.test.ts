import { isFullHtmlDocument } from '@lobehub/ui';
import { describe, expect, it } from 'vitest';

import {
  ensurePreviewableHtmlDocument,
  looksLikeHtmlMarkup,
  shouldPreviewHtmlCodeBlock,
} from './detectHtml';

const FULL_DOC = `<!DOCTYPE html>
<html lang="en">
<head><title>Demo</title></head>
<body><h1>Hello</h1></body>
</html>`;

const FRAGMENT = `<div class="hero">
  <h1>Brew & Bean</h1>
  <p>Artisan coffee, crafted with care.</p>
</div>`;

describe('looksLikeHtmlMarkup', () => {
  it('detects full HTML documents', () => {
    expect(looksLikeHtmlMarkup(FULL_DOC)).toBe(true);
    expect(isFullHtmlDocument(FULL_DOC)).toBe(true);
  });

  it('detects multi-tag structural fragments', () => {
    expect(looksLikeHtmlMarkup(FRAGMENT)).toBe(true);
  });

  it('rejects short or non-structural snippets', () => {
    expect(looksLikeHtmlMarkup('<b>x</b>')).toBe(false);
    expect(looksLikeHtmlMarkup('just plain text')).toBe(false);
    expect(looksLikeHtmlMarkup('')).toBe(false);
  });
});

describe('shouldPreviewHtmlCodeBlock', () => {
  it('previews explicit html fences for documents and fragments', () => {
    expect(shouldPreviewHtmlCodeBlock('html', FULL_DOC)).toBe(true);
    expect(shouldPreviewHtmlCodeBlock('HTML', FRAGMENT)).toBe(true);
    expect(shouldPreviewHtmlCodeBlock('htm', FRAGMENT)).toBe(true);
  });

  it('promotes untagged / plaintext fences only for full documents', () => {
    expect(shouldPreviewHtmlCodeBlock('plaintext', FULL_DOC)).toBe(true);
    expect(shouldPreviewHtmlCodeBlock('', FULL_DOC)).toBe(true);
    expect(shouldPreviewHtmlCodeBlock('text', FULL_DOC)).toBe(true);

    expect(shouldPreviewHtmlCodeBlock('plaintext', FRAGMENT)).toBe(false);
    expect(shouldPreviewHtmlCodeBlock('', FRAGMENT)).toBe(false);
  });

  it('does not steal non-html languages', () => {
    expect(shouldPreviewHtmlCodeBlock('javascript', FULL_DOC)).toBe(false);
    expect(shouldPreviewHtmlCodeBlock('tsx', FRAGMENT)).toBe(false);
    expect(shouldPreviewHtmlCodeBlock('python', FULL_DOC)).toBe(false);
  });
});

describe('ensurePreviewableHtmlDocument', () => {
  it('leaves full documents unchanged', () => {
    expect(ensurePreviewableHtmlDocument(FULL_DOC)).toBe(FULL_DOC);
  });

  it('wraps fragments so HtmlPreview can iframe them', () => {
    const wrapped = ensurePreviewableHtmlDocument(FRAGMENT);
    expect(isFullHtmlDocument(wrapped)).toBe(true);
    expect(wrapped).toContain(FRAGMENT);
    expect(wrapped.toLowerCase()).toContain('<!doctype html>');
  });
});
