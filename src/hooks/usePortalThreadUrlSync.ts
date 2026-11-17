import { useLayoutEffect } from 'react';

import { useChatStore } from '@/store/chat';

/**
 * Bind `?portalThread` to `chatStore.portalThreadId` URL→store.
 *
 * `createStoreUpdater` skips `undefined` values, so removing `?portalThread`
 * from the URL never cleared `portalThreadId` and the composer kept sending
 * into the sub-topic thread while the URL showed the main chat (lost-message
 * reports, production timeline `thd_rqgt7WoC3VzvnQas`). Sync on absence too:
 * the URL is the source of truth in this direction.
 */
export const usePortalThreadUrlSync = (portalThread: string | null) => {
  useLayoutEffect(() => {
    if (useChatStore.getState().portalThreadId === portalThread) return;
    useChatStore.setState({ portalThreadId: portalThread ?? undefined });
  }, [portalThread]);
};
