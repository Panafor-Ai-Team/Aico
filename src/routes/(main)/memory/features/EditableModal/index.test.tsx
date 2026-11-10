/**
 * @vitest-environment happy-dom
 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type OpenEditorModalOptions } from '@/features/EditorModal';

import EditableModal from './index';

const { mockOpenEditorModal, mockToastError, mockUpdateMemory } = vi.hoisted(() => ({
  mockOpenEditorModal: vi.fn(),
  mockToastError: vi.fn(),
  mockUpdateMemory: vi.fn(),
}));

vi.mock('@/features/EditorModal', () => ({
  openEditorModal: mockOpenEditorModal,
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  toast: { error: mockToastError },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/store/userMemory', () => ({
  useUserMemoryStore: (selector: (state: unknown) => unknown) =>
    selector({
      clearEditingMemory: vi.fn(),
      editingMemoryContent: 'original',
      editingMemoryId: 'mem-1',
      editingMemoryLayer: 'context',
      updateMemory: mockUpdateMemory,
    }),
}));

describe('EditableModal', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('shows an error and keeps the editor open when saving fails', async () => {
    mockOpenEditorModal.mockReturnValue({ close: vi.fn() });
    const saveError = new Error('save failed');
    mockUpdateMemory.mockRejectedValue(saveError);

    render(<EditableModal />);

    const options = mockOpenEditorModal.mock.calls[0][0] as OpenEditorModalOptions;

    // A rejection is what tells the editor footer not to close the modal.
    await expect(options.onConfirm!('edited')).rejects.toBe(saveError);
    expect(mockToastError).toHaveBeenCalledWith('edit.error');
  });
});
