import { setCookie } from '@lobechat/utils';
import { changeLanguage } from 'i18next';
import { describe, expect, it, vi } from 'vitest';

import { LOBE_LOCALE_COOKIE } from '@/const/locale';
import { type LocaleMode } from '@/types/locale';

import { hasAutoLocaleCookie, switchLang } from './switchLang';

vi.mock('i18next', () => ({
  changeLanguage: vi.fn(),
}));

vi.mock('@lobechat/utils', () => ({
  setCookie: vi.fn(),
}));

describe('switchLang', () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it('should change language to the specified locale', () => {
    const locale: LocaleMode = 'en-US';
    switchLang(locale);

    expect(changeLanguage).toHaveBeenCalledWith(locale);
    expect(document.documentElement.lang).toBe(locale);
    expect(document.documentElement.dir).toBe('ltr');
    expect(setCookie).toHaveBeenCalledWith(LOBE_LOCALE_COOKIE, locale, 365);
  });

  it('should set rtl direction for Persian', () => {
    switchLang('fa-IR');

    expect(document.documentElement.lang).toBe('fa-IR');
    expect(document.documentElement.dir).toBe('rtl');
  });

  it('should resolve "auto" from the browser language list and persist `auto` in the cookie', () => {
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['fr-CA', 'en-US']);

    switchLang('auto');

    expect(changeLanguage).toHaveBeenCalledWith('fr-FR');
    expect(document.documentElement.lang).toBe('fr-FR');
    // `auto` must stay in the cookie (not be deleted) so a reload can tell it apart from "no choice"
    expect(setCookie).toHaveBeenCalledWith(LOBE_LOCALE_COOKIE, 'auto', 365);
  });

  it('should skip unsupported system languages when resolving "auto"', () => {
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['xx-YY', 'en-GB']);

    switchLang('auto');

    expect(changeLanguage).toHaveBeenCalledWith('en-US');
  });

  it('should fall back to Persian when "auto" has no supported system language', () => {
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['xx-YY']);

    switchLang('auto');

    expect(changeLanguage).toHaveBeenCalledWith('fa-IR');
    expect(document.documentElement.lang).toBe('fa-IR');
    expect(document.documentElement.dir).toBe('rtl');
  });

  it('should prefer the desktop system language over a poisoned navigator.language', () => {
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('en-US');
    vi.stubGlobal('lobeEnv', { systemLanguage: 'zh-CN' });

    switchLang('auto');

    expect(changeLanguage).toHaveBeenCalledWith('zh-CN');
    expect(document.documentElement.lang).toBe('zh-CN');

    vi.unstubAllGlobals();
  });
});

describe('hasAutoLocaleCookie', () => {
  afterEach(() => {
    document.cookie = 'LOBE_LOCALE=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
  });

  it('should be true only when the cookie value is `auto`', () => {
    expect(hasAutoLocaleCookie()).toBe(false);

    document.cookie = 'LOBE_LOCALE=en-US; path=/';
    expect(hasAutoLocaleCookie()).toBe(false);

    document.cookie = 'LOBE_LOCALE=auto; path=/';
    expect(hasAutoLocaleCookie()).toBe(true);
  });
});
