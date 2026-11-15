import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getCacheScope } from '@/libs/swr/useCacheScope';

const PREFIX = 'lobechat:chat-message-queue:v1:';

describe('chat store — durable queue hydration', () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
  });

  it('restores persisted follow-ups on load, never auto-sends, and reset starts empty', async () => {
    localStorage.setItem(
      `${PREFIX}${getCacheScope()}|main_agt_tpc`,
      JSON.stringify([
        { content: 'queued before reload', createdAt: Date.now(), id: 'q1', interruptMode: 'soft' },
      ]),
    );

    const { useChatStore } = await import('./store');
    const state = useChatStore.getState();

    expect(state.queuedMessages['main_agt_tpc']).toEqual([
      expect.objectContaining({ content: 'queued before reload', id: 'q1' }),
    ]);
    // Restored entries wait for the user (send now / edit / delete) or for the
    // next successful turn to drain them — nothing is dispatched on load.
    expect(Object.keys(state.operations)).toHaveLength(0);

    // A reset (sign-out / account switch) must not resurrect the text; the
    // durable copy stays in storage for that user's next sign-in.
    state.reset();
    expect(useChatStore.getState().queuedMessages).toEqual({});
  }, 30_000);
});
