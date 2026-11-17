import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { useChatStore } from '@/store/chat';
import { PortalViewType } from '@/store/chat/slices/portal/initialState';

import { useThreadComposerTarget } from './useThreadComposerTarget';

// Regression (T-041): the composer's write target used to come from the
// free-floating `portalThreadId` field, which can outlive its Thread view
// (pop/close/back-navigation). A stale field then sent messages into a thread
// nothing displays — three days of one customer's messages became invisible.
// The target must resolve from the mounted portal stack view only.
describe('useThreadComposerTarget', () => {
  beforeEach(() => {
    useChatStore.setState({
      portalStack: [],
      portalThreadId: undefined,
      threadStartMessageId: undefined,
    });
  });

  it('resolves the target from the mounted Thread view, not the stale field', () => {
    useChatStore.setState({
      portalStack: [{ threadId: 'thd_visible', type: PortalViewType.Thread }],
      // stale field left behind by a previous view — the T-041 bug state
      portalThreadId: 'thd_hidden',
    });

    const { result } = renderHook(() => useThreadComposerTarget());

    expect(result.current.threadId).toBe('thd_visible');
  });

  it('returns no target when no Thread view is mounted (field alone is not enough)', () => {
    useChatStore.setState({
      portalStack: [],
      portalThreadId: 'thd_hidden',
    });

    const { result } = renderHook(() => useThreadComposerTarget());

    expect(result.current.threadId).toBeUndefined();
    expect(result.current.startMessageId).toBeUndefined();
  });

  it('exposes the creator startMessageId from the mounted view', () => {
    useChatStore.setState({
      portalStack: [{ startMessageId: 'msg_1', type: PortalViewType.Thread }],
    });

    const { result } = renderHook(() => useThreadComposerTarget());

    expect(result.current.startMessageId).toBe('msg_1');
    expect(result.current.threadId).toBeUndefined();
  });
});
