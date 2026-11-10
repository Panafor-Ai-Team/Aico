import { describe, expect, it } from 'vitest';

import { resolvePersistedFileMime } from './persistedFile';

describe('resolvePersistedFileMime', () => {
  it('prefers type', () => {
    expect(resolvePersistedFileMime({ fileType: 'text/plain', type: 'image/png' })).toBe(
      'image/png',
    );
  });

  it('falls back to the raw fileType column', () => {
    expect(resolvePersistedFileMime({ fileType: 'application/pdf' })).toBe('application/pdf');
  });

  it('returns an empty string when neither is set', () => {
    expect(resolvePersistedFileMime({})).toBe('');
    expect(resolvePersistedFileMime({ fileType: null, type: null })).toBe('');
  });
});
