import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { locales } from '@/locales/resources';

const HTML_ENTRIES = ['index.html', 'index.mobile.html', 'index.auth.html'];

const readEntry = (file: string) => readFileSync(path.resolve(__dirname, '../..', file), 'utf8');

const extractLocaleScript = (html: string) => {
  const script = html
    .split('<script>')
    .map((chunk) => chunk.split('</script>')[0])
    .find((chunk) => chunk.includes('LOBE_LOCALE'));
  if (!script) throw new Error('inline locale script not found');
  return script;
};

interface Env {
  cookie?: string;
  hl?: string;
  languages?: string[];
}

/** Run the inline <head> script the way a browser would and return what it stamped on <html>. */
const runInlineScript = (file: string, { cookie = '', hl, languages = [] }: Env) => {
  const documentElement = {
    append: () => {},
    dir: '',
    lang: '',
    setAttribute: () => {},
  };
  const document = {
    cookie,
    // Feature-detection stubs: the page must look like a modern browser or the script bails out
    createElement: () => ({ remove: () => {}, style: {} }),
    documentElement,
  };
  const navigator = { language: languages[0], languages };
  const location = { search: hl ? `?hl=${hl}` : '' };
  // Pass the page's own `window` so `window.location.href` redirects can't navigate the test
  const window = { location: { href: '' }, matchMedia: undefined, lobeEnv: undefined };
  const storage = { getItem: () => null };

  new Function(
    'document',
    'navigator',
    'location',
    'window',
    'localStorage',
    'HTMLScriptElement',
    'getComputedStyle',
    extractLocaleScript(readEntry(file)),
  )(document, navigator, location, window, storage, { supports: () => true }, () => ({
    color: 'rgb(4, 5, 6)',
  }));

  return documentElement;
};

describe.each(HTML_ENTRIES)('%s inline locale script', (file) => {
  it('should default a visitor with no stored choice to Persian, whatever the browser says', () => {
    const el = runInlineScript(file, { languages: ['en-US', 'en'] });

    expect(el.lang).toBe('fa-IR');
    expect(el.dir).toBe('rtl');
  });

  it('should honour an explicitly chosen language', () => {
    const el = runInlineScript(file, { cookie: 'LOBE_LOCALE=fr-FR', languages: ['en-US'] });

    expect(el.lang).toBe('fr-FR');
    expect(el.dir).toBe('ltr');
  });

  it('should resolve the `auto` cookie (System Language) from the browser language list', () => {
    expect(runInlineScript(file, { cookie: 'LOBE_LOCALE=auto', languages: ['en-US'] }).lang).toBe(
      'en-US',
    );
    expect(runInlineScript(file, { cookie: 'LOBE_LOCALE=auto', languages: ['en-GB'] }).lang).toBe(
      'en-US',
    );
    expect(
      runInlineScript(file, { cookie: 'LOBE_LOCALE=auto', languages: ['xx-YY', 'fr-CA'] }).lang,
    ).toBe('fr-FR');
  });

  it('should fall back to Persian when `auto` has no supported or detectable language', () => {
    expect(runInlineScript(file, { cookie: 'LOBE_LOCALE=auto', languages: ['xx-YY'] }).lang).toBe(
      'fa-IR',
    );
    expect(runInlineScript(file, { cookie: 'LOBE_LOCALE=auto', languages: [] }).lang).toBe('fa-IR');
  });

  it('should let ?hl= override the cookie', () => {
    const el = runInlineScript(file, { cookie: 'LOBE_LOCALE=fa-IR', hl: 'en-US' });

    expect(el.lang).toBe('en-US');
  });

  it('should list exactly the shipped locales', () => {
    const match = extractLocaleScript(readEntry(file)).match(/var supportedLocales = \[([^\]]*)\]/);
    const inline = match![1].split(',').map((item) => item.trim().replaceAll("'", ''));

    expect(inline).toEqual([...locales]);
  });
});
