import { describe, expect, it } from 'vitest';

import { getDocumentFileFormat } from './documentFileFormat';

describe('getDocumentFileFormat', () => {
  it('keeps an extension-less agent document as Markdown (.md), whatever its code blocks say', () => {
    // Reproduces the production "Game Landing Page" agent document: no extension,
    // fileType agent/document, body is a fenced code block.
    expect(
      getDocumentFileFormat({
        category: 'document',
        filename: 'Game Landing Page',
        fileType: 'agent/document',
        sourceType: 'agent',
        title: 'Game Landing Page',
      }),
    ).toEqual({
      extension: 'md',
      filename: 'Game Landing Page.md',
      language: 'markdown',
      mimeType: 'text/markdown;charset=utf-8',
      previewKind: 'markdown',
    });
  });

  it('does not double the extension of a Markdown file', () => {
    const format = getDocumentFileFormat({ filename: 'README.md', fileType: 'text/markdown' });

    expect(format.filename).toBe('README.md');
    expect(format.extension).toBe('md');
    expect(format.previewKind).toBe('markdown');
  });

  it('keeps an HTML file as HTML with a rendered preview', () => {
    expect(
      getDocumentFileFormat({
        category: 'document',
        filename: 'landing.html',
        fileType: 'agent/document',
        sourceType: 'agent',
      }),
    ).toEqual({
      extension: 'html',
      filename: 'landing.html',
      language: 'html',
      mimeType: 'text/html;charset=utf-8',
      previewKind: 'html',
    });
  });

  it('keeps code files in their own language and MIME type', () => {
    const css = getDocumentFileFormat({ filename: 'styles.css', fileType: 'text/css' });
    expect(css).toMatchObject({
      extension: 'css',
      filename: 'styles.css',
      language: 'css',
      mimeType: 'text/css;charset=utf-8',
      previewKind: 'code',
    });

    const yaml = getDocumentFileFormat({ filename: 'config.yml', fileType: 'custom/document' });
    expect(yaml).toMatchObject({ language: 'yaml', mimeType: 'application/yaml' });

    const py = getDocumentFileFormat({ filename: 'main.py', fileType: 'custom/document' });
    expect(py).toMatchObject({ language: 'python', mimeType: 'text/plain;charset=utf-8' });
  });

  it('falls back to the title and strips characters that are invalid in filenames', () => {
    expect(getDocumentFileFormat({ title: 'Plan: Q4 / v2' }).filename).toBe('Plan- Q4 - v2.md');
    expect(getDocumentFileFormat({}).filename).toBe('document.md');
  });
});
