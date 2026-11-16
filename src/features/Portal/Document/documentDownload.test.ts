import { describe, expect, it } from 'vitest';

import { getDocumentDownload } from './documentDownload';

describe('getDocumentDownload', () => {
  it('saves an extension-less agent document as Markdown with its live (unsaved) content', () => {
    expect(
      getDocumentDownload(
        {
          category: 'document',
          content: 'saved markdown',
          filename: 'Game Landing Page',
          fileType: 'agent/document',
          sourceType: 'agent',
        },
        '```css\nbody {}\n```\n',
      ),
    ).toEqual({
      content: '```css\nbody {}\n```\n',
      extension: 'md',
      filename: 'Game Landing Page.md',
      mimeType: 'text/markdown;charset=utf-8',
    });
  });

  it('falls back to the stored content when the store has no live copy', () => {
    expect(
      getDocumentDownload({
        content: '# notes',
        fileType: 'markdown',
        filename: null,
        title: 'Notes',
      }),
    ).toMatchObject({ content: '# notes', filename: 'Notes.md' });
  });

  it('saves an .html document with its own name, type and stored source', () => {
    expect(
      getDocumentDownload(
        {
          category: 'document',
          content: '<!DOCTYPE html><html></html>',
          filename: 'landing.html',
          fileType: 'agent/document',
          sourceType: 'agent',
        },
        // A stale rich-editor entry must never replace a file document's source.
        'not the html',
      ),
    ).toEqual({
      content: '<!DOCTYPE html><html></html>',
      extension: 'html',
      filename: 'landing.html',
      mimeType: 'text/html;charset=utf-8',
    });
  });
});
