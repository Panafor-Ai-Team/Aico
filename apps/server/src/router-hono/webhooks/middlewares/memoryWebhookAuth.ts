import type { MiddlewareHandler } from 'hono';

import { verifyMemoryWebhookHeaders } from '@/server/services/memory/userMemory/webhookAuth';

/**
 * Shared header guard for the memory webhook receivers.
 *
 * `MEMORY_USER_MEMORY_WEBHOOK_HEADERS` configures a set of static `header: value` pairs that
 * every caller must present. Aico: these endpoints act on whatever `userId` the body names, so
 * the guard fails closed (503) when no headers are configured instead of letting every caller
 * through — see `verifyMemoryWebhookHeaders`.
 */
export const memoryWebhookAuth = (): MiddlewareHandler => async (c, next) => {
  const failure = verifyMemoryWebhookHeaders(c.req.raw.headers);
  if (failure) return c.json({ error: failure.error }, failure.status);

  await next();
};
