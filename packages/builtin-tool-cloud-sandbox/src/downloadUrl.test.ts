import { describe, expect, it } from 'vitest';

import { isFileProxyUrl, toFileDownloadUrl } from './downloadUrl';

describe('toFileDownloadUrl', () => {
  it('adds the download param to file proxy URLs', () => {
    expect(toFileDownloadUrl('https://app.example.com/f/file_abc')).toBe(
      'https://app.example.com/f/file_abc?download=1',
    );
  });

  it('does not add the param twice', () => {
    expect(toFileDownloadUrl('https://app.example.com/f/file_abc?download=1')).toBe(
      'https://app.example.com/f/file_abc?download=1',
    );
  });

  it('leaves non-proxy URLs untouched so presigned signatures stay valid', () => {
    const presigned =
      'https://s3.example.com/bucket/exports/a.pdf?X-Amz-Signature=abc&X-Amz-Expires=7200';

    expect(isFileProxyUrl(presigned)).toBe(false);
    expect(toFileDownloadUrl(presigned)).toBe(presigned);
    expect(toFileDownloadUrl('not a url')).toBe('not a url');
  });
});
