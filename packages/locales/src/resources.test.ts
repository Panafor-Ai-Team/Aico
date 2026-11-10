import { describe, expect, it } from 'vitest';

import { locales, normalizeLocale, resolveSystemLocale } from './resources';

describe('normalizeLocale', () => {
  it('should return "fa-IR" when locale is undefined', () => {
    expect(normalizeLocale()).toBe('fa-IR');
  });

  it('should return "zh-CN" when locale is "zh-CN"', () => {
    expect(normalizeLocale('zh-CN')).toBe('zh-CN');
  });

  it('should return "zh-CN" when locale is "zh"', () => {
    expect(normalizeLocale('zh')).toBe('zh-CN');
  });

  it('should return "de-DE" when locale is "de"', () => {
    expect(normalizeLocale('de')).toBe('de-DE');
  });

  it('should return "ru-RU" when locale is "ru"', () => {
    expect(normalizeLocale('ru')).toBe('ru-RU');
  });

  it('should return "ar" when locale is "ar-EG"', () => {
    expect(normalizeLocale('ar')).toBe('ar');
    expect(normalizeLocale('ar-EG')).toBe('ar');
  });

  it('should return "en-US" when locale is "en"', () => {
    expect(normalizeLocale('en')).toBe('en-US');
  });

  it('should return the input locale for other valid locales', () => {
    expect(normalizeLocale('fr-FR')).toBe('fr-FR');
    expect(normalizeLocale('ja-JP')).toBe('ja-JP');
    expect(normalizeLocale('ko-KR')).toBe('ko-KR');
    expect(normalizeLocale('pt-BR')).toBe('pt-BR');
    expect(normalizeLocale('tr-TR')).toBe('tr-TR');
    expect(normalizeLocale('vi-VN')).toBe('vi-VN');
    expect(normalizeLocale('zh-TW')).toBe('zh-TW');
  });

  it('should return the default locale for unknown locales', () => {
    expect(normalizeLocale('unknown')).toBe('fa-IR');
    expect(normalizeLocale('fr')).toBe('fr-FR');
  });
});

describe('resolveSystemLocale', () => {
  it('should return the first supported entry of the language list', () => {
    expect(resolveSystemLocale(['en-US', 'fa-IR'])).toBe('en-US');
    expect(resolveSystemLocale(['fr-CA'])).toBe('fr-FR');
    expect(resolveSystemLocale(['en-GB'])).toBe('en-US');
    expect(resolveSystemLocale('fr')).toBe('fr-FR');
  });

  it('should skip unsupported entries instead of stopping at them', () => {
    expect(resolveSystemLocale(['xx-YY', 'en-GB'])).toBe('en-US');
  });

  it('should map Chinese variants by script and region', () => {
    expect(resolveSystemLocale(['zh'])).toBe('zh-CN');
    expect(resolveSystemLocale(['zh-Hans-CN'])).toBe('zh-CN');
    expect(resolveSystemLocale(['zh-Hant'])).toBe('zh-TW');
    expect(resolveSystemLocale(['zh-HK'])).toBe('zh-TW');
  });

  it('should map ar-* to ar and fa-* to fa-IR', () => {
    expect(resolveSystemLocale(['ar-EG'])).toBe('ar');
    expect(resolveSystemLocale(['fa-AF'])).toBe('fa-IR');
  });

  it('should fall back to Persian when nothing is supported or detectable', () => {
    expect(resolveSystemLocale(['xx-YY'])).toBe('fa-IR');
    expect(resolveSystemLocale([])).toBe('fa-IR');
    expect(resolveSystemLocale(undefined)).toBe('fa-IR');
    expect(resolveSystemLocale([''])).toBe('fa-IR');
  });

  it('should resolve every shipped locale to itself', () => {
    for (const locale of locales) {
      expect(resolveSystemLocale([locale])).toBe(locale);
    }
  });
});
