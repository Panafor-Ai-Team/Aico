import { createElement, Fragment } from 'react';
import { describe, expect, it } from 'vitest';

import { extractTextFromReactNode, getTextDirectionFromFirstStrong } from './textDirection';

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

describe('extractTextFromReactNode', () => {
  it('passes plain strings through', () => {
    expect(extractTextFromReactNode('سلام world')).toBe('سلام world');
  });

  it('joins arrays such as stream-animation spans', () => {
    expect(extractTextFromReactNode(['Hello', ' ', 'سلام'])).toBe('Hello سلام');
  });

  it('reads through elements, fragments and nesting', () => {
    const node = createElement(
      Fragment,
      null,
      createElement('span', null, 'Hello'),
      ' ',
      createElement('span', null, createElement('b', null, 'سلام')),
    );
    expect(extractTextFromReactNode(node)).toBe('Hello سلام');
  });

  it('ignores nullish, boolean and unknown children', () => {
    expect(extractTextFromReactNode(null)).toBe('');
    expect(extractTextFromReactNode(undefined)).toBe('');
    expect(extractTextFromReactNode(false)).toBe('');
    expect(extractTextFromReactNode([null, 'hi', false])).toBe('hi');
  });

  it('keeps first-strong order across node boundaries', () => {
    // Persian word wrapped in its own span must not steal the direction when
    // the message starts with English.
    const node = [createElement('span', null, 'Hello'), createElement('span', null, 'سلام')];
    expect(getTextDirectionFromFirstStrong(extractTextFromReactNode(node))).toBe('ltr');
  });
});
