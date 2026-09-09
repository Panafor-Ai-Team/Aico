import { describe, expect, it } from 'vitest';

import { getTextDirectionFromFirstStrong, resolveTextDirection } from './textDirection';

describe('getTextDirectionFromFirstStrong', () => {
  it('returns rtl when the first strong character is Persian/Arabic', () => {
    expect(getTextDirectionFromFirstStrong('سلام world')).toBe('rtl');
    expect(getTextDirectionFromFirstStrong('  سلام')).toBe('rtl');
  });

  it('returns ltr when the first strong character is Latin', () => {
    expect(getTextDirectionFromFirstStrong('hello سلام')).toBe('ltr');
    expect(getTextDirectionFromFirstStrong('  hello')).toBe('ltr');
  });

  it('keeps rtl when English appears mid Persian sentence', () => {
    expect(getTextDirectionFromFirstStrong('من از GPT استفاده می‌کنم')).toBe('rtl');
  });

  it('ignores leading digits and punctuation', () => {
    expect(getTextDirectionFromFirstStrong('123 سلام')).toBe('rtl');
    expect(getTextDirectionFromFirstStrong('...hello')).toBe('ltr');
  });

  it('returns null for empty or neutral-only text', () => {
    expect(getTextDirectionFromFirstStrong('')).toBeNull();
    expect(getTextDirectionFromFirstStrong('   ')).toBeNull();
    expect(getTextDirectionFromFirstStrong('123')).toBeNull();
  });
});

describe('resolveTextDirection', () => {
  it('takes direction from the first strong character, whatever the UI language', () => {
    expect(resolveTextDirection('سلام world', 'ltr')).toBe('rtl');
    expect(resolveTextDirection('hello سلام', 'rtl')).toBe('ltr');
  });

  it('falls back to the UI language when there is no strong character', () => {
    // Persian UI → right, English UI → left.
    expect(resolveTextDirection('', 'rtl')).toBe('rtl');
    expect(resolveTextDirection('', 'ltr')).toBe('ltr');
    expect(resolveTextDirection('123 ...', 'rtl')).toBe('rtl');
  });
});
