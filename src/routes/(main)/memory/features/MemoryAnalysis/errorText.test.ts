import { describe, expect, it } from 'vitest';

import { getMemoryAnalysisErrorText } from './errorText';

describe('getMemoryAnalysisErrorText', () => {
  /**
   * @example
   * The banner used to show only "Memory extraction completed with retrieval errors".
   */
  it('appends the real reason from structured retrieval errors', () => {
    const text = getMemoryAnalysisErrorText({
      body: {
        detail: 'Memory extraction completed with retrieval errors',
        retrievalErrors: [
          {
            cause: { code: '403', message: 'Access denied by security policy.' },
            message: 'Failed to embed',
            stack: 'Error: secret stack',
            stage: 'retrieval',
          },
        ],
      },
      name: 'ServerError',
    });

    expect(text).toBe(
      'Memory extraction completed with retrieval errors\n[retrieval] 403: Access denied by security policy.',
    );
  });

  it('returns the plain detail when there are no structured items', () => {
    expect(getMemoryAnalysisErrorText({ body: { detail: 'Timed out' }, name: 'Timeout' })).toBe(
      'Timed out',
    );
  });

  it('keeps string bodies, drops duplicates and limits the number of lines', () => {
    expect(getMemoryAnalysisErrorText({ body: 'plain', name: 'X' })).toBe('plain');

    const item = { message: 'same', stage: 'extract' };
    const many = Array.from({ length: 5 }, (_, i) => ({ message: `m${i}`, stage: 'persist' }));
    const text = getMemoryAnalysisErrorText({
      body: { detail: 'D', extractErrors: [item, item], persistErrors: many },
      name: 'X',
    });

    expect(text?.split('\n')).toEqual(['D', '[extract] same', '[persist] m0', '[persist] m1']);
  });

  it('falls back to the error name', () => {
    expect(getMemoryAnalysisErrorText({ body: { detail: '' }, name: 'ServerError' })).toBe(
      'ServerError',
    );
  });
});
