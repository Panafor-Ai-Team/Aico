import { act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { documentService } from '@/services/document';
import { usePageStore } from '@/store/page';
import { DocumentSourceType, type LobeDocument } from '@/types/document';

vi.mock('@/store/global', () => ({
  useGlobalStore: {
    getState: () => ({
      status: { pagePageSize: 20 },
    }),
  },
}));

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

beforeEach(() => {
  vi.restoreAllMocks();
  usePageStore.setState({ documents: [doc('docs_existing')] });
});

describe('page list refetch during an upload', () => {
  it('keeps the uploaded page when the list refetches before the parse finishes', async () => {
    // Closing the file picker re-focuses the window, so SWR refetches the list
    // while the upload is still running. The server list has no optimistic page.
    vi.spyOn(documentService, 'getPageDocuments').mockResolvedValue([doc('docs_existing') as any]);

    let tempId = '';
    act(() => {
      tempId = usePageStore.getState().createOptimisticPage('report');
    });

    await act(async () => {
      await usePageStore.getState().fetchDocuments();
    });

    expect(usePageStore.getState().documents?.map((d) => d.id)).toEqual([tempId, 'docs_existing']);

    act(() => {
      usePageStore
        .getState()
        .replaceTempPageWithReal(tempId, doc('docs_uploaded', { sourceType: 'file' as any }));
    });

    expect(usePageStore.getState().documents?.map((d) => d.id)).toEqual([
      'docs_uploaded',
      'docs_existing',
    ]);
  });

  it('does not keep the optimistic page once the server list already has the real one', async () => {
    let tempId = '';
    act(() => {
      tempId = usePageStore.getState().createOptimisticPage('report');
    });
    act(() => {
      usePageStore.getState().replaceTempPageWithReal(tempId, doc('docs_uploaded'));
    });

    vi.spyOn(documentService, 'getPageDocuments').mockResolvedValue([
      doc('docs_uploaded') as any,
      doc('docs_existing') as any,
    ]);

    await act(async () => {
      await usePageStore.getState().fetchDocuments();
    });

    expect(usePageStore.getState().documents?.map((d) => d.id)).toEqual([
      'docs_uploaded',
      'docs_existing',
    ]);
  });
});
