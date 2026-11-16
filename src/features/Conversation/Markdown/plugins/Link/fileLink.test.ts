import { describe, expect, it } from 'vitest';

import { parseFileProxyLink } from './fileLink';

const ORIGIN = 'https://chat.example.com';

describe('parseFileProxyLink', () => {
  it('parses root-relative and same-origin file proxy links', () => {
    expect(parseFileProxyLink('/f/file_abc', ORIGIN)).toEqual({ fileId: 'file_abc' });
    expect(parseFileProxyLink('/f/file_abc')).toEqual({ fileId: 'file_abc' });
    expect(parseFileProxyLink(`${ORIGIN}/f/file_abc`, ORIGIN)).toEqual({ fileId: 'file_abc' });
    expect(parseFileProxyLink(`${ORIGIN}/f/file_abc/#top`, ORIGIN)).toEqual({
      fileId: 'file_abc',
    });
  });

  it('rejects other hosts and protocol-relative links', () => {
    expect(parseFileProxyLink('https://other.example.com/f/file_abc', ORIGIN)).toBeNull();
    expect(parseFileProxyLink('//other.example.com/f/file_abc', ORIGIN)).toBeNull();
    expect(parseFileProxyLink(`${ORIGIN}/f/file_abc`)).toBeNull();
  });

  it('keeps explicit download links as downloads', () => {
    expect(parseFileProxyLink('/f/file_abc?download', ORIGIN)).toBeNull();
    expect(parseFileProxyLink('/f/file_abc?download=1', ORIGIN)).toBeNull();
  });

  it('ignores paths that are not a single file id under /f', () => {
    expect(parseFileProxyLink('/f', ORIGIN)).toBeNull();
    expect(parseFileProxyLink('/f/', ORIGIN)).toBeNull();
    expect(parseFileProxyLink('/f/file_abc/extra', ORIGIN)).toBeNull();
    expect(parseFileProxyLink('/files/file_abc', ORIGIN)).toBeNull();
    expect(parseFileProxyLink(undefined, ORIGIN)).toBeNull();
  });
});
