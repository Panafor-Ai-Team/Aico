import { getCacheScope } from '@/libs/swr/useCacheScope';

import type { QueuedFile, QueuedMessage } from './types';

/**
 * The input queue lives in memory while the tab is open. Without a disk copy a
 * reload (or a stale-chunk recovery reload) silently drops every follow-up the
 * user queued behind a running reply — the composer was already cleared when
 * they hit Enter, so the text exists nowhere else.
 *
 * Entries are partitioned by the same cache scope (user + workspace) the SWR
 * cache uses, so two accounts sharing a browser can never see or auto-send each
 * other's queued text. One key per conversation keeps cross-tab writes small.
 *
 * Restored entries are NOT auto-sent. A client-side run dies with the tab and
 * the server may still be finishing the previous turn, so auto-sending could
 * duplicate a message. The tray shows them and the user decides (send now /
 * edit / delete), or the next successful turn drains them as usual.
 */
export const CHAT_MESSAGE_QUEUE_STORAGE_PREFIX = 'lobechat:chat-message-queue:v1:';

/** Long enough for a weekend away, short enough to not resurrect ancient input. */
const MAX_QUEUE_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_ITEMS_PER_CONTEXT = 100;
/** ~1 MB of UTF-16 per conversation; far below the usual 5 MB quota. */
const MAX_CHARS_PER_CONTEXT = 1_000_000;
const KEY_SEPARATOR = '|';

const currentScope = () => getCacheScope();

const queueStorageKey = (scope: string, contextKey: string) =>
  `${CHAT_MESSAGE_QUEUE_STORAGE_PREFIX}${scope}${KEY_SEPARATOR}${contextKey}`;

const isQueuedFile = (value: unknown): value is QueuedFile => {
  if (!value || typeof value !== 'object') return false;
  const file = value as QueuedFile;
  return (
    typeof file.id === 'string' &&
    typeof file.mimeType === 'string' &&
    typeof file.name === 'string' &&
    typeof file.url === 'string'
  );
};

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const isQueuedMessage = (value: unknown): value is QueuedMessage => {
  if (!isRecord(value)) return false;
  const message = value as unknown as QueuedMessage;

  return (
    typeof message.id === 'string' &&
    typeof message.content === 'string' &&
    typeof message.createdAt === 'number' &&
    (message.interruptMode === 'soft' || message.interruptMode === 'hard') &&
    (message.files === undefined || isStringArray(message.files)) &&
    (message.filesPreview === undefined ||
      (Array.isArray(message.filesPreview) && message.filesPreview.every(isQueuedFile))) &&
    (message.editorData === undefined || isRecord(message.editorData)) &&
    (message.metadata === undefined || isRecord(message.metadata))
  );
};

/**
 * Strips resources that cannot survive a reload or would bloat localStorage.
 * Blob URLs die with the tab and `data:` images can be megabytes; the file is
 * still attached to the message by id, so only the thumbnail is lost.
 */
const toPersistableMessage = (message: QueuedMessage): QueuedMessage => ({
  ...message,
  filesPreview: message.filesPreview?.map((file) => ({
    ...file,
    url: file.url.startsWith('blob:') || file.url.startsWith('data:') ? '' : file.url,
  })),
});

const parseQueue = (raw: string | null | undefined, now: number): QueuedMessage[] => {
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    return parsed.filter(isQueuedMessage).filter((message) => {
      // A clock-skewed future stamp is kept: dropping it would lose real input.
      return message.createdAt > now || now - message.createdAt <= MAX_QUEUE_AGE_MS;
    });
  } catch {
    return [];
  }
};

/** Merge two queue snapshots by id, keeping the newer entry and stable order. */
export const unionQueuedMessages = (
  first: QueuedMessage[],
  second: QueuedMessage[],
): QueuedMessage[] => {
  const byId = new Map<string, QueuedMessage>();
  for (const message of first) byId.set(message.id, message);
  for (const message of second) byId.set(message.id, message);

  return [...byId.values()].sort((a, b) => a.createdAt - b.createdAt);
};

const trimQueue = (messages: QueuedMessage[]): QueuedMessage[] => {
  if (messages.length <= MAX_ITEMS_PER_CONTEXT) return messages;

  const kept = [...messages]
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(messages.length - MAX_ITEMS_PER_CONTEXT);
  // Avoid a warn on every write once the cap is steady.
  if (messages.length === MAX_ITEMS_PER_CONTEXT + 1) {
    console.warn(
      '[queueStorage] over the %d item cap; dropping the oldest queued message',
      MAX_ITEMS_PER_CONTEXT,
    );
  }
  return kept;
};

const writeQueueItems = (key: string, messages: QueuedMessage[]): void => {
  try {
    if (messages.length === 0) {
      window.localStorage.removeItem(key);
      return;
    }

    const persistable = trimQueue(messages).map(toPersistableMessage);
    let serialized = JSON.stringify(persistable);
    if (serialized.length > MAX_CHARS_PER_CONTEXT) {
      // Keep the newest items that fit instead of failing the whole write.
      // The rest stay in memory only (the current tab still shows them).
      const newestFirst = [...persistable].sort((a, b) => b.createdAt - a.createdAt);
      const kept: QueuedMessage[] = [];
      for (const message of newestFirst) {
        if (kept.length > 0) {
          const candidate = JSON.stringify([message, ...kept]);
          if (candidate.length > MAX_CHARS_PER_CONTEXT) break;
        }
        kept.push(message);
      }
      console.warn(
        '[queueStorage] queue exceeds the storage cap; only the newest %d of %d messages persist',
        kept.length,
        persistable.length,
      );
      serialized = JSON.stringify(kept.sort((a, b) => a.createdAt - b.createdAt));
    }

    window.localStorage.setItem(key, serialized);
  } catch (error) {
    // Quota or privacy mode: the current tab keeps working from memory.
    console.warn('[queueStorage] failed to persist queue:', error);
  }
};

const readStoredQueue = (key: string, now = Date.now()): QueuedMessage[] => {
  try {
    return parseQueue(window.localStorage.getItem(key), now);
  } catch {
    return [];
  }
};

export const readQueue = (contextKey: string, now = Date.now()): QueuedMessage[] => {
  if (typeof window === 'undefined' || !contextKey) return [];
  return readStoredQueue(queueStorageKey(currentScope(), contextKey), now);
};

/**
 * Reads every queue for the current scope. Expired or corrupt entries are
 * removed so a shared browser does not accumulate dead text forever.
 */
export const readAllQueues = (now = Date.now()): Record<string, QueuedMessage[]> => {
  if (typeof window === 'undefined') return {};

  const scope = currentScope();
  const prefix = `${CHAT_MESSAGE_QUEUE_STORAGE_PREFIX}${scope}${KEY_SEPARATOR}`;
  const queues: Record<string, QueuedMessage[]> = {};
  const staleKeys: string[] = [];

  try {
    const keys: string[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key?.startsWith(prefix)) keys.push(key);
    }

    for (const key of keys) {
      const contextKey = key.slice(prefix.length);
      const items = readStoredQueue(key, now);
      if (items.length > 0) queues[contextKey] = items;
      else staleKeys.push(key);
    }

    staleKeys.forEach((key) => window.localStorage.removeItem(key));
  } catch {
    return {};
  }

  return queues;
};

/** Adds entries without clobbering a queue another tab wrote in the meantime. */
export const addQueuedMessages = (contextKey: string, messages: QueuedMessage[]): void => {
  if (typeof window === 'undefined' || !contextKey || messages.length === 0) return;

  const key = queueStorageKey(currentScope(), contextKey);
  const stored = readStoredQueue(key);
  writeQueueItems(key, unionQueuedMessages(stored, messages));
};

/** Removes exact ids only, so a concurrent tab's other entries stay queued. */
export const removeQueuedMessageIds = (contextKey: string, ids: string[]): void => {
  if (typeof window === 'undefined' || !contextKey || ids.length === 0) return;

  const key = queueStorageKey(currentScope(), contextKey);
  const stored = readStoredQueue(key);
  if (stored.length === 0) return;

  const removed = new Set(ids);
  writeQueueItems(
    key,
    stored.filter((message) => !removed.has(message.id)),
  );
};

export const removeQueue = (contextKey: string): void => {
  if (typeof window === 'undefined' || !contextKey) return;
  try {
    window.localStorage.removeItem(queueStorageKey(currentScope(), contextKey));
  } catch {
    // ignore
  }
};
