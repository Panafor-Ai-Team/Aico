import { DEFAULT_LANG } from '@/const/locale';

import type resources from './default';

export const locales = [
  'ar',
  'bg-BG',
  'de-DE',
  'en-US',
  'es-ES',
  'fr-FR',
  'ja-JP',
  'ko-KR',
  'pt-BR',
  'ru-RU',
  'tr-TR',
  'zh-CN',
  'zh-TW',
  'vi-VN',
  'fa-IR',
  'it-IT',
  'pl-PL',
  'nl-NL',
] as const;

export type DefaultResources = typeof resources;
export type NS = keyof DefaultResources;
export type Locales = (typeof locales)[number];

export const normalizeLocale = (locale?: string): Locales => {
  if (!locale) return DEFAULT_LANG;

  const lowerLocale = locale.toLowerCase();

  if (lowerLocale.startsWith('ar')) return 'ar';
  if (lowerLocale.startsWith('fa')) return 'fa-IR';

  if (lowerLocale.startsWith('cn')) return 'zh-CN';
  if (lowerLocale.startsWith('zh-hans')) return 'zh-CN';
  if (lowerLocale.startsWith('zh-hant')) return 'zh-TW';

  for (const l of locales) {
    if (l.startsWith(locale)) {
      return l;
    }
  }

  return DEFAULT_LANG;
};

const matchSupportedLocale = (tag: string): Locales | undefined => {
  const lower = tag.trim().toLowerCase().replaceAll('_', '-');
  if (!lower || lower === '*') return;

  const primary = lower.split('-')[0];
  if (primary === 'zh') {
    return /(?:^|-)(?:hant|tw|hk|mo)(?:-|$)/.test(lower) ? 'zh-TW' : 'zh-CN';
  }

  const exact = locales.find((l) => l.toLowerCase() === lower);
  if (exact) return exact;

  return locales.find((l) => l.toLowerCase().split('-')[0] === primary);
};

/**
 * Resolve the "System Language" (`auto`) choice from the browser / OS language list.
 * Walks the list in preference order and returns the first supported locale; falls back to
 * DEFAULT_LANG when the list is empty or has no supported entry. Unlike `normalizeLocale`,
 * an unsupported entry does not stop the walk (`['ja-XX', 'en-GB']` → en-US).
 *
 * Keep in sync with the inline script in `index.html`, `index.mobile.html` and `index.auth.html`
 * (guarded by `src/spa/htmlLocaleScript.test.ts`).
 */
export const resolveSystemLocale = (languages?: readonly string[] | string | null): Locales => {
  const list = typeof languages === 'string' ? [languages] : (languages ?? []);

  for (const tag of list) {
    const matched = matchSupportedLocale(tag);
    if (matched) return matched;
  }

  return DEFAULT_LANG;
};

type LocaleOptions = {
  label: string;
  value: Locales;
}[];

/** Locales shown in language pickers (others remain supported but hidden). */
export const VISIBLE_LOCALES = ['fa-IR', 'en-US', 'fr-FR'] as const satisfies readonly Locales[];

export const localeOptions: LocaleOptions = [
  {
    label: 'فارسی',
    value: 'fa-IR',
  },
  {
    label: 'English',
    value: 'en-US',
  },
  {
    label: '简体中文',
    value: 'zh-CN',
  },
  {
    label: '繁體中文',
    value: 'zh-TW',
  },
  {
    label: '日本語',
    value: 'ja-JP',
  },
  {
    label: '한국어',
    value: 'ko-KR',
  },
  {
    label: 'Deutsch',
    value: 'de-DE',
  },
  {
    label: 'Español',
    value: 'es-ES',
  },
  {
    label: 'العربية',
    value: 'ar',
  },
  {
    label: 'Français',
    value: 'fr-FR',
  },
  {
    label: 'Português',
    value: 'pt-BR',
  },
  {
    label: 'Русский',
    value: 'ru-RU',
  },
  {
    label: 'Türkçe',
    value: 'tr-TR',
  },
  {
    label: 'Polski',
    value: 'pl-PL',
  },
  {
    label: 'Nederlands',
    value: 'nl-NL',
  },
  {
    label: 'Italiano',
    value: 'it-IT',
  },
  {
    label: 'Tiếng Việt',
    value: 'vi-VN',
  },
  {
    label: 'Български',
    value: 'bg-BG',
  },
] as LocaleOptions;

export const visibleLocaleOptions = localeOptions.filter((option) =>
  // VISIBLE_LOCALES is a narrow tuple, so `includes` would only accept its own
  // members; widen it to test membership across all locale options.
  (VISIBLE_LOCALES as readonly string[]).includes(option.value),
);

export const supportLocales: string[] = [...locales, 'en', 'zh'];
