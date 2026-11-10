import {
  Composio,
  ComposioConnectedAccountNotFoundError,
  ConnectedAccountErrorCodes,
} from '@composio/core';
import { toRecord } from '@lobechat/utils/object';

import { getServerComposioApiKey } from '@/config/composio';

let composioClientInstance: { apiKey: string; client: Composio } | undefined;

/**
 * Identifies an explicit Composio connected-account-not-found error.
 *
 * Use when:
 * - `tools.execute` emits the normalized Composio error class or code
 *
 * Expects:
 * - The SDK has already classified the failure as a missing connected account
 *
 * Returns:
 * - `true` only for the concrete connected-account error, code, or stable name
 */
export const isComposioConnectedAccountNotFoundError = (error: unknown): boolean => {
  if (error instanceof ComposioConnectedAccountNotFoundError) return true;

  const record = toRecord(error);
  if (!record) return false;
  if (record.code === ConnectedAccountErrorCodes.CONNECTED_ACCOUNT_NOT_FOUND) return true;
  return record.name === 'ComposioConnectedAccountNotFoundError';
};

/**
 * Identifies a missing account at the dedicated connected-account lookup boundary.
 *
 * Use when:
 * - `connectedAccounts.get` may expose the generated API client's raw HTTP 404
 *
 * Expects:
 * - The attempted HTTP operation only retrieves a known connected-account ID
 *
 * Returns:
 * - `true` for an explicit connected-account error or a direct lookup HTTP 404
 */
export const isComposioConnectedAccountLookupNotFoundError = (error: unknown): boolean => {
  if (isComposioConnectedAccountNotFoundError(error)) return true;

  const record = toRecord(error);
  return record?.status === 404 || record?.statusCode === 404;
};

/**
 * Revokes a Composio connected account (deletes it, and the OAuth token it holds).
 *
 * Use when:
 * - A connection is disconnected, uninstalled or replaced
 *
 * Expects:
 * - Callers delete their own DB rows only after this resolves, so a failed revoke
 *   never leaves an ACTIVE account behind with no row pointing at it (such an
 *   orphan keeps the token alive and blocks `connectedAccounts.link` for the user)
 *
 * Returns:
 * - Resolves when the account is gone, including when it was already missing;
 *   rethrows any other failure
 */
export const revokeComposioConnectedAccount = async (
  client: Composio,
  connectedAccountId: string,
): Promise<void> => {
  try {
    await client.connectedAccounts.delete(connectedAccountId);
  } catch (error) {
    if (!isComposioConnectedAccountLookupNotFoundError(error)) throw error;
  }
};

export interface ComposioToolOutcome {
  content: string;
  /** Composio's error text; set only when the tool failed. */
  error?: string;
  success: boolean;
}

const stringifyComposioPayload = (payload: unknown): string => {
  if (typeof payload === 'string') return payload;
  if (Array.isArray(payload)) {
    return payload
      .map((item: any) => {
        if (typeof item === 'string') return item;
        if (item?.type === 'text' && item.text) return item.text;
        return JSON.stringify(item);
      })
      .join('\n');
  }
  return JSON.stringify(payload ?? null);
};

const isEmptyPayload = (payload: unknown) =>
  payload === undefined ||
  payload === null ||
  payload === '' ||
  (typeof payload === 'object' && Object.keys(payload as object).length === 0);

/**
 * Maps a `tools.execute` response (`{ data, error, successful }`) to a tool result.
 *
 * Use when:
 * - Returning a Composio execution to the model, from any executor
 *
 * Expects:
 * - The raw SDK response; Composio reports a failed upstream call (e.g. GitHub
 *   404) as a resolved response with `successful: false`, not as a throw
 *
 * Returns:
 * - `success: false` with Composio's error text (plus any data it returned) when
 *   the tool failed, so the model sees why instead of an empty "success"
 */
export const toComposioToolOutcome = (result: unknown): ComposioToolOutcome => {
  const record = toRecord(result);
  const payload = record ? (record.data ?? record.result ?? result) : result;
  const errorText = typeof record?.error === 'string' && record.error ? record.error : undefined;

  if (record?.successful === false || errorText) {
    const error = errorText ?? 'Composio tool execution failed';
    const content = isEmptyPayload(payload)
      ? error
      : `${error}\n\n${stringifyComposioPayload(payload)}`;
    return { content, error, success: false };
  }

  return { content: stringifyComposioPayload(payload), success: true };
};

export const getComposioClient = (): Composio => {
  const apiKey = getServerComposioApiKey();

  if (!apiKey) {
    throw new Error('Composio API key is not configured on server');
  }

  if (!composioClientInstance || composioClientInstance.apiKey !== apiKey) {
    composioClientInstance = {
      apiKey,
      client: new Composio({ apiKey }),
    };
  }

  return composioClientInstance.client;
};

export const isComposioClientAvailable = (): boolean => {
  return !!getServerComposioApiKey();
};
