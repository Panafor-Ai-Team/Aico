import { TRPCClientError } from '@trpc/client';
import { describe, expect, it, vi } from 'vitest';

import { NonJsonHttpResponseError } from '@/libs/trpc/client/lambda';

import { describeSendFailure } from '../entries/describeSendFailure';

vi.mock('i18next', () => ({ t: (key: string) => key }));

const trpcError = (status: number) =>
  new TRPCClientError(`HTTP ${status}`, { cause: new NonJsonHttpResponseError(status) });

describe('describeSendFailure', () => {
  it('names an oversized body instead of a JSON parse error', () => {
    expect(describeSendFailure(trpcError(413))).toBe('input.errorTooLarge');
  });

  it.each([502, 503, 504])('reports an unavailable server for an HTML %i', (status) => {
    expect(describeSendFailure(trpcError(status))).toBe('input.errorServerUnavailable');
  });

  it('keeps the server message for any other failure', () => {
    expect(describeSendFailure(new TRPCClientError('FORBIDDEN: no access'))).toBe(
      'FORBIDDEN: no access',
    );
    expect(describeSendFailure(trpcError(500))).toBe('HTTP 500');
  });
});
