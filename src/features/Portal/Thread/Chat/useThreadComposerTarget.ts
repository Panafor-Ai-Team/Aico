import { useChatStore } from '@/store/chat';
import { portalThreadSelectors } from '@/store/chat/selectors';

/**
 * Resolve the composer's write target from the Thread view that is actually
 * mounted in the portal stack — never from the free-floating `portalThreadId`
 * field.
 *
 * That field can outlive its Thread view (pop/close/back-navigation, hydration
 * timing), and a target resolved from it silently writes messages into a
 * thread nothing displays — the T-041 lost-message class. The stack view is
 * the same source the portal renders from, so what the composer writes to and
 * what the user sees can never disagree.
 */
export const useThreadComposerTarget = () => {
  const threadView = useChatStore(portalThreadSelectors.currentThreadView);

  return {
    startMessageId: threadView?.startMessageId,
    threadId: threadView?.threadId,
  };
};
