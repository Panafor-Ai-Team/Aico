import type { TFunction } from 'i18next';
import { describe, expect, it } from 'vitest';

import pluginLocale from '@/locales/default/plugin';

import { getSkillDisplayName } from './skillDisplayName';

const t = ((key: string) =>
  (pluginLocale as Record<string, string>)[key] ?? key) as TFunction<'plugin'>;

describe('getSkillDisplayName', () => {
  it('shows a product-neutral label for the builtin lobehub skill', () => {
    const name = getSkillDisplayName(t, 'lobehub');

    expect(name).toBe('Platform Management');
    expect(name).not.toMatch(/lobe/i);
  });

  it('prefers the skill title when one is set', () => {
    expect(getSkillDisplayName(t, 'agent-skills:apk', 'APK Reverse')).toBe('APK Reverse');
  });

  it('keeps user skill names as they are', () => {
    expect(getSkillDisplayName(t, 'apk-reverse')).toBe('apk-reverse');
  });

  it('returns nothing without a name or title', () => {
    expect(getSkillDisplayName(t)).toBeUndefined();
  });
});
