import { type Locales, normalizeLocale } from '@/locales/resources';

export interface LocaleFontConfig {
  fontFamily: string;
  fontURL: string;
}

export const LOCALE_FONT_CONFIG: Partial<Record<Locales, LocaleFontConfig>> = {
  'fa-IR': {
    fontFamily: 'Vazirmatn',
    fontURL: '/fonts/vazirmatn/font-face.css',
  },
};

export const getLocaleFontConfig = (locale?: string): LocaleFontConfig | null => {
  const normalized = normalizeLocale(locale);

  return LOCALE_FONT_CONFIG[normalized] ?? null;
};

export const mergeThemeFontFamily = (
  primary: string | undefined,
  baseFontFamily: string,
): string | undefined => (primary ? `${primary},${baseFontFamily}` : undefined);
