/**
 * @vitest-environment happy-dom
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EditorModal } from './index';

vi.mock('@lobehub/editor/react', () => ({
  useEditor: () => ({ getDocument: (type: string) => (type === 'markdown' ? 'edited' : {}) }),
}));

vi.mock('./EditorCanvas', () => ({
  default: () => null,
}));

vi.mock('@/components/ImperativeModal', () => ({
  default: ({ confirmLoading, onOk }: { confirmLoading?: boolean; onOk?: () => Promise<void> }) => (
    <button data-loading={String(!!confirmLoading)} onClick={() => onOk?.().catch(() => {})}>
      ok
    </button>
  ),
}));

describe('EditorModal', () => {
  afterEach(() => {
    cleanup();
  });

  it('stops the confirm loading state when saving fails', async () => {
    const onConfirm = vi.fn().mockRejectedValue(new Error('save failed'));
    render(<EditorModal open value="original" onConfirm={onConfirm} />);

    await act(async () => {
      screen.getByRole('button').click();
    });

    expect(onConfirm).toHaveBeenCalledWith('edited', {});
    expect(screen.getByRole('button').dataset.loading).toBe('false');
  });
});
