import { supportLocales } from '@/locales/resources';

export const DEFAULT_LANG = 'fa-IR';
export const LOBE_LOCALE_COOKIE = 'LOBE_LOCALE';
/** Cookie value meaning "follow the browser / OS language"; an absent cookie means no choice yet. */
export const LOBE_LOCALE_AUTO = 'auto';

/**
 * Check if the language is supported
 * @param locale
 */
export const isLocaleNotSupport = (locale: string) => !supportLocales.includes(locale);
