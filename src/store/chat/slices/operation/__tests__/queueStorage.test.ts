import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getCacheScope } from '@/libs/swr/useCacheScope';

import {
  addQueuedMessages,
  CHAT_MESSAGE_QUEUE_STORAGE_PREFIX,
  readAllQueues,
  readQueue,
  removeQueue,
  removeQueuedMessageIds,
  unionQueuedMessages,
} from '../queueStorage';
import type { QueuedMessage } from '../types';

const NOW = Date.now();

const message = (id: string, overrides: Partial<QueuedMessage> = {}): QueuedMessage => ({
  content: `content-${id}`,
  createdAt: NOW,
  id,
  interruptMode: 'soft',
  ...overrides,
});

beforeEach(() => {
  localStorage.clear();
});

describe('queueStorage', () => {
  it('round-trips a queue for the current scope only', () => {
    addQueuedMessages('main_agt_tpc', [message('q1'), message('q2', { createdAt: NOW + 1 })]);

    expect(readQueue('main_agt_tpc').map((item) => item.id)).toEqual(['q1', 'q2']);
    expect(readAllQueues()).toEqual({
      main_agt_tpc: [expect.objectContaining({ id: 'q1' }), expect.objectContaining({ id: 'q2' })],
    });
    // Another user's partition is not hydrated into this scope.
    localStorage.setItem(
      `${CHAT_MESSAGE_QUEUE_STORAGE_PREFIX}someone-else|main_agt_tpc`,
      JSON.stringify([message('foreign')]),
    );
    expect(readQueue('main_agt_tpc').map((item) => item.id)).toEqual(['q1', 'q2']);
  });

  it('adds without clobbering an entry another writer already stored', () => {
    addQueuedMessages('main_agt_tpc', [message('q1')]);
    addQueuedMessages('main_agt_tpc', [message('q2'), message('q1')]);

    expect(readQueue('main_agt_tpc').map((item) => item.id)).toEqual(['q1', 'q2']);
  });

  it('removes only the requested ids', () => {
    addQueuedMessages('main_agt_tpc', [message('q1'), message('q2')]);
    removeQueuedMessageIds('main_agt_tpc', ['q1']);

    expect(readQueue('main_agt_tpc').map((item) => item.id)).toEqual(['q2']);
  });

  it('drops blob/data preview URLs but keeps usable ones', () => {
    addQueuedMessages('main_agt_tpc', [
      message('q1', {
        files: ['file-1'],
        filesPreview: [
          { id: 'file-1', mimeType: 'image/png', name: 'a.png', url: 'blob:http://local/abc' },
          { id: 'file-2', mimeType: 'image/png', name: 'b.png', url: 'https://cdn.test/b.png' },
          { id: 'file-3', mimeType: 'image/png', name: 'c.png', url: 'data:image/png;base64,AAA' },
          { id: 'file-4', mimeType: 'image/png', name: 'd.png', url: '/f/local.png' },
        ],
      }),
    ]);

    expect(readQueue('main_agt_tpc')[0].filesPreview).toEqual([
      { id: 'file-1', mimeType: 'image/png', name: 'a.png', url: '' },
      { id: 'file-2', mimeType: 'image/png', name: 'b.png', url: 'https://cdn.test/b.png' },
      { id: 'file-3', mimeType: 'image/png', name: 'c.png', url: '' },
      { id: 'file-4', mimeType: 'image/png', name: 'd.png', url: '/f/local.png' },
    ]);
  });

  it('ignores corrupt entries and prunes them', () => {
    localStorage.setItem(
      `${CHAT_MESSAGE_QUEUE_STORAGE_PREFIX}${getCacheScope()}|main_agt_tpc`,
      '{not json',
    );

    expect(readAllQueues()).toEqual({});
    expect(localStorage.length).toBe(0);
  });

  it('drops entries older than 30 days', () => {
    const now = NOW + 100 * 24 * 60 * 60 * 1000;
    addQueuedMessages('main_agt_tpc', [
      message('old', { createdAt: NOW - 31 * 24 * 60 * 60 * 1000 }),
    ]);

    expect(readQueue('main_agt_tpc', now)).toEqual([]);
    expect(readAllQueues(now)).toEqual({});
  });

  it('removeQueue clears the whole conversation bucket', () => {
    addQueuedMessages('main_agt_tpc', [message('q1')]);
    removeQueue('main_agt_tpc');

    expect(readQueue('main_agt_tpc')).toEqual([]);
  });
});

describe('unionQueuedMessages', () => {
  it('dedupes by id and keeps createdAt order', () => {
    const merged = unionQueuedMessages(
      [message('b', { createdAt: NOW + 2_000 }), message('a', { createdAt: NOW + 1_000 })],
      [
        message('a', { content: 'newer', createdAt: NOW + 1_000 }),
        message('c', { createdAt: NOW + 3_000 }),
      ],
    );

    expect(merged.map((item) => item.id)).toEqual(['a', 'b', 'c']);
    expect(merged[0].content).toBe('newer');
  });
});

describe('storage failures', () => {
  it('keeps working in memory when localStorage throws', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() => addQueuedMessages('main_agt_tpc', [message('q1')])).not.toThrow();

    setItem.mockRestore();
    warn.mockRestore();
  });
});
