import { beforeEach, describe, expect, it, vi } from 'vitest';

import app from '../index';

/**
 * The memory webhooks act on whatever `userId` the request body names, so the shared
 * `memoryWebhookAuth` guard must reject every request unless auth headers are configured
 * (Aico fails closed; upstream's guard was a no-op without headers), and reject wrong
 * headers when they are. Handlers are mocked: a rejected request must never reach them.
 */
const mocks = vi.hoisted(() => {
  const handler = vi.fn();
  return {
    config: { webhook: { headers: {} as Record<string, string> } },
    handler,
    ok: (c: { json: (body: unknown) => Response }) => {
      handler();
      return c.json({ ok: true });
    },
  };
});

vi.mock('@/server/globalConfig/parseMemoryExtractionConfig', () => ({
  parseMemoryExtractionConfig: () => mocks.config,
}));

vi.mock('../handlers/casdoor', () => ({ casdoorWebhook: vi.fn() }));
vi.mock('../handlers/logto', () => ({ logtoWebhook: vi.fn() }));
vi.mock('../handlers/video', () => ({ videoWebhook: vi.fn() }));
vi.mock('../handlers/memoryExtraction', () => ({ memoryExtractionWebhook: mocks.ok }));
vi.mock('../handlers/memoryExtractionBenchmarkLocomo', () => ({
  memoryExtractionBenchmarkLocomo: mocks.ok,
}));
vi.mock('../handlers/memoryUserMemoryChatTopicCancel', () => ({
  memoryUserMemoryChatTopicCancel: mocks.ok,
}));
vi.mock('../handlers/memoryUserMemoryPersonaUpdateWriting', () => ({
  memoryUserMemoryPersonaUpdateWriting: mocks.ok,
}));

const paths = [
  '/api/webhooks/memory-extraction',
  '/api/webhooks/memory-extraction/benchmark-locomo',
  '/api/webhooks/memory-user-memory/persona/update-writing',
  '/api/webhooks/memory-user-memory/pipelines/extract/chat-topic/cancel',
];

const post = (path: string, headers: Record<string, string> = {}) =>
  app.request(path, {
    body: JSON.stringify({ userIds: ['user-1'] }),
    headers: { 'content-type': 'application/json', ...headers },
    method: 'POST',
  });

describe.each(paths)('memory webhook auth: %s', (path) => {
  beforeEach(() => {
    mocks.handler.mockClear();
    mocks.config.webhook.headers = {};
  });

  it('rejects every request with 503 when no auth headers are configured', async () => {
    const response = await post(path);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error:
        'Memory webhook authentication is not configured. Set MEMORY_USER_MEMORY_WEBHOOK_HEADERS.',
    });
    expect(mocks.handler).not.toHaveBeenCalled();
  });

  it('rejects a request whose auth header is missing or wrong with 403', async () => {
    mocks.config.webhook.headers = { 'x-memory-secret': 'secret' };

    const missing = await post(path);
    const wrong = await post(path, { 'x-memory-secret': 'not-the-secret' });

    expect(missing.status).toBe(403);
    expect(wrong.status).toBe(403);
    expect(await wrong.json()).toEqual({
      error: "Unauthorized: Missing or invalid header 'x-memory-secret'",
    });
    expect(mocks.handler).not.toHaveBeenCalled();
  });

  it('lets a request with the configured header through to the handler', async () => {
    mocks.config.webhook.headers = { 'x-memory-secret': 'secret' };

    const response = await post(path, { 'x-memory-secret': 'secret' });

    expect(response.status).toBe(200);
    expect(mocks.handler).toHaveBeenCalledTimes(1);
  });
});
