import { parseMemoryExtractionConfig } from '@/server/globalConfig/parseMemoryExtractionConfig';

export interface MemoryWebhookAuthFailure {
  error: string;
  status: 403 | 503;
}

/**
 * Shared header guard for the memory webhook receivers.
 *
 * These are privileged server-to-server endpoints: they act on whatever `userId` the request body
 * names, and a browser session does not authenticate them. `MEMORY_USER_MEMORY_WEBHOOK_HEADERS`
 * configures the `header=value` pairs every caller must present. When none are configured the
 * guard rejects the request instead of leaving the memory pipeline open.
 *
 * Returns the failure to send back, or `undefined` when the request may proceed.
 */
export const verifyMemoryWebhookHeaders = (
  headers: Headers,
): MemoryWebhookAuthFailure | undefined => {
  const { webhook } = parseMemoryExtractionConfig();

  if (!webhook.headers || Object.keys(webhook.headers).length === 0) {
    return {
      error:
        'Memory webhook authentication is not configured. Set MEMORY_USER_MEMORY_WEBHOOK_HEADERS.',
      status: 503,
    };
  }

  for (const [key, value] of Object.entries(webhook.headers)) {
    if (headers.get(key) !== value) {
      return { error: `Unauthorized: Missing or invalid header '${key}'`, status: 403 };
    }
  }

  return undefined;
};
