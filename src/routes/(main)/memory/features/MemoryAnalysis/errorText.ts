import { type AsyncTaskStructuredErrorItem, type IAsyncTaskError } from '@lobechat/types';

const MAX_DETAIL_LINES = 3;
const MAX_LINE_LENGTH = 300;

const describeItem = (item: AsyncTaskStructuredErrorItem) => {
  // Lower-level failures (provider, database) are wrapped in `cause`; the innermost one is the real reason.
  let inner = item;
  while (inner.cause) inner = inner.cause;

  const label = [item.stage, item.layer].filter(Boolean).join('/');
  const code = inner.code || item.code;
  const message = inner.message || item.message;
  const line = `${label ? `[${label}] ` : ''}${code ? `${code}: ` : ''}${message}`;

  return line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}…` : line;
};

/**
 * Builds the text shown in the memory analysis error banner.
 *
 * Use when:
 * - A user-initiated memory extraction ended in `Error`
 *
 * Expects:
 * - `error` is the async task error as stored by the server, possibly with structured items
 *
 * Returns:
 * - The headline, followed by up to three distinct per-stage detail lines. Stack traces are never included.
 */
export const getMemoryAnalysisErrorText = (error?: IAsyncTaskError | null): string | undefined => {
  const body = error?.body;
  if (typeof body === 'string') return body;
  if (!body || typeof body !== 'object') return error?.name;

  const items = [
    ...(body.retrievalErrors ?? []),
    ...(body.extractErrors ?? []),
    ...(body.persistErrors ?? []),
    ...(body.progressErrors ?? []),
  ];
  const lines = [...new Set(items.map(describeItem))].slice(0, MAX_DETAIL_LINES);

  return [body.detail, ...lines].filter(Boolean).join('\n') || error?.name;
};
