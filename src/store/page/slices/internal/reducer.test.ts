import { describe, expect, it } from 'vitest';

import { DocumentSourceType, type LobeDocument } from '@/types/document';

import { documentsReducer } from './reducer';

const doc = (id: string, overrides: Partial<LobeDocument> = {}): LobeDocument => ({
  content: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  editorData: null,
  fileType: 'custom/document',
  filename: id,
  id,
  metadata: {},
  source: 'document',
  sourceType: DocumentSourceType.EDITOR,
  title: id,
  totalCharCount: 0,
  totalLineCount: 0,
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

describe('documentsReducer', () => {
  describe('replaceDocument', () => {
    it('replaces the optimistic document in place', () => {
      const state = [doc('docs_a'), doc('temp-page-1'), doc('docs_b')];

      const next = documentsReducer(state, {
        document: doc('docs_real'),
        oldId: 'temp-page-1',
        type: 'replaceDocument',
      });

      expect(next?.map((d) => d.id)).toEqual(['docs_a', 'docs_real', 'docs_b']);
    });

    it('inserts the real document when the optimistic one was already dropped', () => {
      // A list refetch can replace the whole array before the upload finishes.
      const state = [doc('docs_a'), doc('docs_b')];

      const next = documentsReducer(state, {
        document: doc('docs_real'),
        oldId: 'temp-page-1',
        type: 'replaceDocument',
      });

      expect(next?.map((d) => d.id)).toEqual(['docs_real', 'docs_a', 'docs_b']);
    });

    it('updates the existing entry instead of duplicating it when the refetch already has it', () => {
      const state = [doc('docs_a'), doc('docs_real', { title: 'stale' })];

      const next = documentsReducer(state, {
        document: doc('docs_real', { title: 'fresh' }),
        oldId: 'temp-page-1',
        type: 'replaceDocument',
      });

      expect(next?.map((d) => d.id)).toEqual(['docs_a', 'docs_real']);
      expect(next?.[1].title).toBe('fresh');
    });
  });
});
