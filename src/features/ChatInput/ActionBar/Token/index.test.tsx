import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import ContextWindow from './index';

vi.mock('@/hooks/useModelHasContextWindowToken', () => ({
  useModelHasContextWindowToken: () => true,
}));

// A tab opened before a deploy requests a chunk hash that no longer exists.
vi.mock('./TokenTag', () => {
  throw new Error('Failed to fetch dynamically imported module: /_spa/assets/TokenTag-old.js');
});

describe('ContextWindow token tag', () => {
  it('renders nothing when the token tag chunk fails to load', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <div data-testid="bar">
        <ContextWindow />
      </div>,
    );

    await waitFor(() => expect(consoleError).toHaveBeenCalled());
    expect(screen.getByTestId('bar')).toBeEmptyDOMElement();

    consoleError.mockRestore();
  });
});
