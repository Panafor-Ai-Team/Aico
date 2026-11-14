import { builtinToolIdentifiers } from '@lobechat/builtin-tools/identifiers';
import { describe, expect, it } from 'vitest';

import pluginLocale from '@/locales/default/plugin';

import { pluginHelpers } from './helpers';

/** Minimal i18next stand-in backed by the real default `plugin` namespace. */
const t = (key: string, options: { defaultValue: string }) =>
  (pluginLocale as Record<string, string>)[key] ?? options.defaultValue;

describe('pluginHelpers.getToolFallbackName', () => {
  it('drops the internal lobe- prefix from a tool identifier', () => {
    expect(pluginHelpers.getToolFallbackName('lobe-activator')).toBe('activator');
  });

  it('keeps identifiers without the prefix', () => {
    expect(pluginHelpers.getToolFallbackName('web-search')).toBe('web-search');
  });
});

describe('pluginHelpers.getToolDisplayName', () => {
  it('shows the localized title for lobe-skill-store, not its identifier', () => {
    expect(pluginHelpers.getToolDisplayName('lobe-skill-store', t)).toBe('Skill Store');
  });

  it('prefers the localized builtin title over a persisted English name', () => {
    expect(pluginHelpers.getToolDisplayName('lobe-skill-store', t, 'lobe-skill-store')).toBe(
      'Skill Store',
    );
  });

  it('uses the given title for tools without a builtin title', () => {
    expect(pluginHelpers.getToolDisplayName('github', t, 'GitHub')).toBe('GitHub');
  });

  it('never falls back to the raw identifier when the title is the identifier', () => {
    expect(pluginHelpers.getToolDisplayName('lobe-unknown-tool', t, 'lobe-unknown-tool')).toBe(
      'unknown-tool',
    );
  });

  it.each(builtinToolIdentifiers.filter((id) => id.startsWith('lobe-')))(
    'gives builtin tool %s a localized title free of upstream brands',
    (identifier) => {
      const name = pluginHelpers.getToolDisplayName(identifier, t);

      expect(pluginLocale).toHaveProperty([`builtins.${identifier}.title`]);
      expect(name).not.toMatch(/lobe|openrouter|cheapvibecode|\bcvc\b/i);
    },
  );
});
