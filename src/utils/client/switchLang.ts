import { setCookie } from '@lobechat/utils';
import { changeLanguage } from 'i18next';

import { LOBE_LOCALE_AUTO, LOBE_LOCALE_COOKIE } from '@/const/locale';
import { resolveSystemLocale } from '@/locales/resources';
import { type LocaleMode } from '@/types/locale';
import { applyDocumentDirection } from '@/utils/client/applyDocumentDirection';
import { getSystemLanguages } from '@/utils/client/systemLanguage';

export const switchLang = (locale: LocaleMode) => {
  const lang = locale === 'auto' ? resolveSystemLocale(getSystemLanguages()) : locale;

  changeLanguage(lang);
  document.documentElement.lang = lang;
  applyDocumentDirection(lang);

  // `auto` is persisted as its own cookie value (not by deleting the cookie) so the next page
  // load can tell "follow the system" apart from "no choice yet" (which defaults to Persian).
  setCookie(LOBE_LOCALE_COOKIE, locale === 'auto' ? LOBE_LOCALE_AUTO : locale, 365);
};

export const hasAutoLocaleCookie = () =>
  typeof document !== 'undefined' &&
  document.cookie
    .split(';')
    .some((item) => item.trim() === `${LOBE_LOCALE_COOKIE}=${LOBE_LOCALE_AUTO}`);
