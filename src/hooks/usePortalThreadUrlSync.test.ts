import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { MemoryRouter, Route, Routes, useNavigate, useSearchParams } from 'react-router';
import { describe, expect, it } from 'vitest';

import { useChatStore } from '@/store/chat';

import { usePortalThreadUrlSync } from './usePortalThreadUrlSync';

// Navigate programmatically through the router itself (MemoryRouter ignores
// window.history). `setPath` is captured by the probe component.
let setPath: (path: string) => void = () => {};

const NavigateProbe = () => {
  const navigate = useNavigate();
  setPath = navigate;
  return null;
};

// Mirror ThreadHydration's wiring: the hook reads the URL param via the router.
const useHarness = () => {
  const [searchParams] = useSearchParams();
  usePortalThreadUrlSync(searchParams.get('portalThread'));
};

const mountHarness = (initialUrl: string) =>
  renderHook(() => useHarness(), {
    wrapper: ({ children }) =>
      createElement(
        MemoryRouter,
        { initialEntries: [initialUrl] },
        createElement(
          Routes,
          null,
          createElement(Route, {
            path: '*',
            element: createElement('div', null, children, createElement(NavigateProbe)),
          }),
        ),
      ),
  });

// Regression: `createStoreUpdater` skips `undefined` values, so removing
// `?portalThread` from the URL never cleared `portalThreadId`. The composer
// then kept writing into the sub-topic thread while the URL showed the main
// chat, and every message landed in a thread the user could not see.
describe('usePortalThreadUrlSync', () => {
  it('clears portalThreadId when the URL loses ?portalThread', async () => {
    const { rerender } = mountHarness('/chat?portalThread=thd_test123');

    expect(useChatStore.getState().portalThreadId).toBe('thd_test123');

    act(() => {
      setPath('/chat');
      rerender();
    });

    await waitFor(() => {
      expect(useChatStore.getState().portalThreadId).toBeUndefined();
    });
  });

  it('sets portalThreadId when the URL gains ?portalThread', async () => {
    const { rerender } = mountHarness('/chat');

    expect(useChatStore.getState().portalThreadId).toBeUndefined();

    act(() => {
      setPath('/chat?portalThread=thd_test456');
      rerender();
    });

    await waitFor(() => {
      expect(useChatStore.getState().portalThreadId).toBe('thd_test456');
    });
  });
});
