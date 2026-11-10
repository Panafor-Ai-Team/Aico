import { isDesktop } from '@lobechat/const';

import { DEFAULT_LANG } from '@/const/locale';
import { type Locales, resolveSystemLocale } from '@/locales/resources';
import { getSystemLanguages } from '@/utils/client/systemLanguage';
import { isOnServerSide } from '@/utils/env';

import { type GlobalState } from '../initialState';
import { systemStatus } from './systemStatus';

// Web defaults to Persian until the user picks a language; only desktop follows the OS by default.
const language = (s: GlobalState) =>
  systemStatus(s).language || (isDesktop ? 'auto' : DEFAULT_LANG);

const currentLanguage = (s: GlobalState) => {
  const locale = language(s);

  if (locale === 'auto') {
    if (isOnServerSide) return DEFAULT_LANG;

    return resolveSystemLocale(getSystemLanguages()) as Locales;
  }

  return locale as Locales;
};

export const globalGeneralSelectors = {
  currentLanguage,
  language,
};
