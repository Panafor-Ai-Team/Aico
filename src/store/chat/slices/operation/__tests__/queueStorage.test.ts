import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  addQueuedMessages,
  CHAT_MESSAGE_QUEUE_STORAGE_PREFIX,
  parseQueueStorageKey,
  readAllQueues,
  readQueue,
  readQueueStorageChange,
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

const queueKeys = () => {
  const keys: string[] = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (key?.startsWith(CHAT_MESSAGE_QUEUE_STORAGE_PREFIX)) keys.push(key);
  }
  return keys;
};

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

  it('parses the scope and context key back out of a storage key', () => {
    expect(
      parseQueueStorageKey(`${CHAT_MESSAGE_QUEUE_STORAGE_PREFIX}u1:personal|main_agt_new`),
    ).toEqual({ contextKey: 'main_agt_new', scope: 'u1:personal' });
    expect(parseQueueStorageKey('unrelated')).toBeNull();
    expect(parseQueueStorageKey(`${CHAT_MESSAGE_QUEUE_STORAGE_PREFIX}broken`)).toBeNull();
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

  it('drops blob preview URLs but keeps the uploaded file reference', () => {
    addQueuedMessages('main_agt_tpc', [
      message('q1', {
        files: ['file-1'],
        filesPreview: [
          { id: 'file-1', mimeType: 'image/png', name: 'a.png', url: 'blob:http://local/abc' },
          { id: 'file-2', mimeType: 'image/png', name: 'b.png', url: 'https://cdn.test/b.png' },
        ],
      }),
    ]);

    expect(readQueue('main_agt_tpc')[0].filesPreview).toEqual([
      { id: 'file-1', mimeType: 'image/png', name: 'a.png', url: '' },
      { id: 'file-2', mimeType: 'image/png', name: 'b.png', url: 'https://cdn.test/b.png' },
    ]);
  });

  it('ignores corrupt entries and prunes them', () => {
    localStorage.setItem(
      `${CHAT_MESSAGE_QUEUE_STORAGE_PREFIX}${getCurrentScope()}|main_agt_tpc`,
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

  it('mirrors a storage event only for the current scope', () => {
    addQueuedMessages('main_agt_tpc', [message('q1')]);
    const [key] = queueKeys();
    const raw = localStorage.getItem(key);

    expect(readQueueStorageChange(key, raw)?.messages.map((item) => item.id)).toEqual(['q1']);
    expect(
      readQueueStorageChange(`${CHAT_MESSAGE_QUEUE_STORAGE_PREFIX}other:personal|x`, raw),
    ).toBeNull();
    expect(readQueueStorageChange(key, null)).toEqual({ contextKey: 'main_agt_tpc', messages: [] });
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

// The storage key is scope-prefixed; tests only need the scope value that the
// module resolved for the current test identity.
function getCurrentScope(): string {
  addQueuedMessages('__scope_probe__', [message('probe')]);
  const key = queueKeys().find((item) => item.includes('|__scope_probe__'));
  removeQueuedMessageIds('__scope_probe__', ['probe']);
  return parseQueueStorageKey(key ?? null)?.scope ?? '';
}
