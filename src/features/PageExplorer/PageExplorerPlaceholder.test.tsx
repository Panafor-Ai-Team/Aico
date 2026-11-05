/**
 * @vitest-environment happy-dom
 */
import { fireEvent, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { usePageStore } from '@/store/page';

import PageExplorerPlaceholder from './PageExplorerPlaceholder';

const mocks = vi.hoisted(() => ({
  parseDocument: vi.fn(),
  toastError: vi.fn(),
  uploadWithProgress: vi.fn(),
}));

vi.mock('@/features/NavHeader', () => ({ default: () => null }));

vi.mock('@/features/ResourceManager/components/Header/hooks/useNotionImport', () => ({
  default: () => ({
    handleNotionImport: vi.fn(),
    handleOpenNotionGuide: vi.fn(),
    notionInputRef: { current: null },
  }),
}));

vi.mock('@/hooks/usePermission', () => ({
  usePermission: () => ({ allowed: true }),
}));

vi.mock('@lobehub/ui/base-ui', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  toast: { error: mocks.toastError },
}));

vi.mock('@/store/file', () => {
  const state = { createDocument: vi.fn(), uploadWithProgress: mocks.uploadWithProgress };
  const useFileStore = (selector: (s: typeof state) => unknown) => selector(state);
  useFileStore.getState = () => state;
  return { useFileStore };
});

vi.mock('@/libs/trpc/client', () => ({
  lambdaClient: { document: { parseDocument: { mutate: mocks.parseDocument } } },
}));

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const uploadDocx = (container: HTMLElement) => {
  const input = container.querySelector('input[type="file"][accept*=".docx"]') as HTMLInputElement;
  const file = new File(['docx-bytes'], 'report.docx', { type: DOCX_MIME });
  fireEvent.change(input, { target: { files: [file] } });
};

describe('PageExplorerPlaceholder .docx upload', () => {
  const navigate = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    usePageStore.setState({ documents: [], navigate, selectedPageId: null });
    mocks.uploadWithProgress.mockResolvedValue({ id: 'file_1', url: 'files/report.docx' });
  });

  it('opens the parsed page through the router and keeps it in the list', async () => {
    mocks.parseDocument.mockResolvedValue({
      content: 'Hello',
      fileType: 'custom/document',
      id: 'docs_parsed',
      sourceType: 'file',
      title: 'report',
    });

    const { container } = render(<PageExplorerPlaceholder />);
    uploadDocx(container);

    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/page/parsed'));

    const state = usePageStore.getState();
    expect(state.selectedPageId).toBe('docs_parsed');
    expect(state.documents?.map((d) => d.id)).toEqual(['docs_parsed']);
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it('removes the optimistic page and tells the user when parsing fails', async () => {
    mocks.parseDocument.mockRejectedValue(new Error('parse failed'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const { container } = render(<PageExplorerPlaceholder />);
    uploadDocx(container);

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledTimes(1));

    expect(usePageStore.getState().documents).toEqual([]);
    expect(navigate).not.toHaveBeenCalled();
  });
});
