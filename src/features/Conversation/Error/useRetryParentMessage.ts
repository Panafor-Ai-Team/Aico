import { useCallback, useState } from 'react';

import { useConversationStore } from '@/features/Conversation/store';

/** Runs before the retry; resolving to `false` skips the retry. */
type BeforeRetry = () => Promise<boolean | void> | boolean | void;

export const useRetryParentMessage = (id: string) => {
  const [loading, setLoading] = useState(false);

  const regenerateUserMessage = useConversationStore((s) => s.regenerateUserMessage);
  const parentId = useConversationStore(
    (s) => s.displayMessages.find((m) => m.id === id)?.parentId,
  );

  const retryParentMessage = useCallback(
    async (beforeRetry?: BeforeRetry) => {
      if (!parentId) return;

      setLoading(true);
      try {
        if ((await beforeRetry?.()) === false) return;
        await regenerateUserMessage(parentId);
      } finally {
        setLoading(false);
      }
    },
    [parentId, regenerateUserMessage],
  );

  return {
    disabled: !parentId,
    loading,
    parentId,
    retryParentMessage,
  };
};
