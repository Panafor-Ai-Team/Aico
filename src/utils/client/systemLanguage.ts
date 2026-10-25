/**
 * On desktop, `navigator.language` reports English regardless of the OS setting
 * because packaging prunes the locales Chromium resolves its app locale from.
 * The main process reads the OS language directly and hands it to the preload.
 */
export const getSystemLanguage = (): string =>
  (typeof window !== 'undefined' && window.lobeEnv?.systemLanguage) || navigator.language;

/** The ordered language preference list; desktop reports a single OS language. */
export const getSystemLanguages = (): string[] => {
  if (typeof window !== 'undefined' && window.lobeEnv?.systemLanguage) {
    return [window.lobeEnv.systemLanguage];
  }
  if (typeof navigator === 'undefined') return [];

  const languages = navigator.languages?.length ? navigator.languages : [navigator.language];
  return languages.filter(Boolean);
};
