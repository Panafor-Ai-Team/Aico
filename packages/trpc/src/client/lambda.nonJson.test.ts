// @vitest-environment node
import { TRPCClientError } from '@trpc/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { getNonJsonHttpStatus, lambdaClient, NonJsonHttpResponseError } from './lambda';

vi.mock('@/services/_auth', () => ({ createHeaderWithAuth: async () => ({}) }));
vi.mock('@/business/client/trpc-headers', () => ({ getBusinessTrpcHeaders: async () => ({}) }));

const html = (status: number) =>
  new Response('<html>\r\n<head><title>error</title></head></html>', {
    headers: { 'content-type': 'text/html' },
    status,
  });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('lambdaClient non-JSON error responses', () => {
  // nginx answers an oversized body with its own HTML page; tRPC used to
  // `res.json()` it and show "Unexpected token '<'" with the status lost.
  it('keeps the status of an HTML 413 instead of a JSON parse error', async () => {
    vi.stubGlobal('location', { pathname: '/chat' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(html(413)));

    const error = await (lambdaClient as any).aiChat.sendMessageInServer
      .mutate({})
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TRPCClientError);
    expect((error as Error).message).not.toContain('Unexpected token');
    expect(getNonJsonHttpStatus(error)).toBe(413);
  });
});

describe('getNonJsonHttpStatus', () => {
  it('reads the status from the error cause only', () => {
    expect(getNonJsonHttpStatus({ cause: new NonJsonHttpResponseError(502) })).toBe(502);
    expect(getNonJsonHttpStatus(new Error('x'))).toBeUndefined();
    expect(getNonJsonHttpStatus(null)).toBeUndefined();
  });
});
