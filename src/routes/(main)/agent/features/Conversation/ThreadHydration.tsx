'use client';

import { memo, useEffect, useLayoutEffect } from 'react';

import { useFetchThreads } from '@/hooks/useFetchThreads';
import { usePortalThreadUrlSync } from '@/hooks/usePortalThreadUrlSync';
import { useQueryState } from '@/hooks/useQueryParam';
import { useChatStore } from '@/store/chat';
import { PortalViewType } from '@/store/chat/slices/portal/initialState';

// sync outside state to useChatStore
const ThreadHydration = memo(() => {
  // two-way bindings the topic params to chat store
  const [portalThread, setThread] = useQueryState('portalThread');
  // URL → store, including clearing when the param disappears.
  usePortalThreadUrlSync(portalThread);

  useLayoutEffect(() => {
    const unsubscribe = useChatStore.subscribe(
      (s) => s.portalThreadId,
      (state) => {
        setThread(state || null);
      },
    );

    return () => {
      unsubscribe();
    };
  }, [setThread]); // ✅ Now setValue is stable, can be safely added to the dependency array

  // should open portal automatically when portalThread is set
  useEffect(() => {
    if (!!portalThread && !useChatStore.getState().showPortal) {
      useChatStore
        .getState()
        .pushPortalView({ threadId: portalThread, type: PortalViewType.Thread });
    }
  }, [portalThread]);

  const activeTopicId = useChatStore((s) => s.activeTopicId);

  useFetchThreads(activeTopicId);

  return null;
});

export default ThreadHydration;
