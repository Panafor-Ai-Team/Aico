/**
 * @vitest-environment happy-dom
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ManageMemoryButton } from './ManageMemoryButton';

const mockNavigate = vi.fn();

vi.mock('@/features/Workspace/useWorkspaceAwareNavigate', () => ({
  useWorkspaceAwareNavigate: () => mockNavigate,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe('ManageMemoryButton', () => {
  afterEach(() => {
    cleanup();
    mockNavigate.mockReset();
  });

  // The web build mounts the same desktop router as Electron, so `/memory` exists there too.
  it('opens the memory manager on the web build', () => {
    render(<ManageMemoryButton />);

    screen.getByRole('button', { name: 'memory.manageEntry' }).click();

    expect(mockNavigate).toHaveBeenCalledWith('/memory', { escape: true });
  });
});
