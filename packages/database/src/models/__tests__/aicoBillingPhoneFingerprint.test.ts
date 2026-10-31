import { describe, expect, it } from 'vitest';

import { normalizeIranianPhoneForFingerprint } from '../aicoBilling';

describe('normalizeIranianPhoneForFingerprint', () => {
  it.each([
    ['09121111111'],
    ['+989121111111'],
    ['989121111111'],
    ['0912-111-1111'],
    ['۰۹۱۲۱۱۱۱۱۱۱'],
    ['٠٩١٢١١١١١١١'],
    // Fullwidth digits / plus from CJK-style input methods, as accepted at sign-in.
    ['０９１２１１１１１１１'],
    ['＋９８９１２１１１１１１１'],
  ])('normalizes %s to the same E.164 fingerprint', (raw) => {
    expect(normalizeIranianPhoneForFingerprint(raw)).toBe('+989121111111');
  });

  it.each(['', '02112345678', '+15551234567'])('rejects %s', (raw) => {
    expect(() => normalizeIranianPhoneForFingerprint(raw)).toThrow('INVALID_PHONE');
  });
});
