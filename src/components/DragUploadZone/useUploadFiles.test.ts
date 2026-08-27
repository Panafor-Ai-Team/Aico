import { act, renderHook } from '@testing-library/react';
import { type Mock } from 'vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as visualMediaUploadAbilityModule from '@/hooks/useVisualMediaUploadAbility';
import { useVisualMediaUploadAbility } from '@/hooks/useVisualMediaUploadAbility';
import { useFileStore } from '@/store/file';

import { useUploadFiles } from './useUploadFiles';

vi.mock('@/hooks/useVisualMediaUploadAbility', async (importOriginal) => ({
  ...(await importOriginal<typeof visualMediaUploadAbilityModule>()),
  useVisualMediaUploadAbility: vi.fn(),
}));
vi.mock('@/store/file');

const mockedUseVisualMediaUploadAbility = vi.mocked(useVisualMediaUploadAbility);
const mockedUseFileStore = vi.mocked(useFileStore);

describe('useUploadFiles', () => {
  let uploadChatFiles: Mock;

  beforeEach(() => {
    uploadChatFiles = vi.fn();
    mockedUseFileStore.mockImplementation((selector: any) => selector({ uploadChatFiles } as any));
    mockedUseVisualMediaUploadAbility.mockReturnValue({
      canUploadAudio: false,
      canUploadDocument: true,
      canUploadImage: false,
      canUploadVideo: false,
    });
  });

  it('drops an image file the model cannot receive and still uploads the rest', async () => {
    const { result } = renderHook(() =>
      useUploadFiles({ agentId: 'agent-1', model: 'model', provider: 'provider' }),
    );

    const imageFile = new File([''], 'test.png', { type: 'image/png' });
    const docFile = new File([''], 'doc.pdf', { type: 'application/pdf' });

    await act(async () => {
      await result.current.handleUploadFiles([imageFile, docFile]);
    });

    // Regression: previously the document branch always returned `true`
    // unconditionally, so this filtering only ever caught image/video/audio —
    // a model with files: false would still get PDFs uploaded to it.
    expect(uploadChatFiles).toHaveBeenCalledWith([docFile], 'agent-1');
  });

  it('drops a document when the model has files: false', async () => {
    mockedUseVisualMediaUploadAbility.mockReturnValue({
      canUploadAudio: false,
      canUploadDocument: false,
      canUploadImage: false,
      canUploadVideo: false,
    });

    const { result } = renderHook(() =>
      useUploadFiles({ agentId: 'agent-1', model: 'model', provider: 'provider' }),
    );

    const docFile = new File([''], 'doc.pdf', { type: 'application/pdf' });

    await act(async () => {
      await result.current.handleUploadFiles([docFile]);
    });

    expect(uploadChatFiles).not.toHaveBeenCalled();
  });
});
