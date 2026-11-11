import { describe, expect, it } from 'vitest';

import defaultSetting from '@/locales/default/setting';
import { SettingsTabs } from '@/store/global/initialState';

import {
  SETTINGS_SEARCH_ITEMS,
  type SettingsSearchContext,
  TAB_SEARCH_EN_KEYWORDS,
  TAB_SEARCH_KEYWORDS_KEYS,
} from './items';

const ctx = (overrides: Partial<SettingsSearchContext> = {}): SettingsSearchContext => ({
  disableEmailPassword: false,
  enableBusinessFeatures: false,
  enableComposio: false,
  enableGatewayMode: false,
  enableSTT: false,
  hasEmail: true,
  hideDocs: false,
  isDesktop: false,
  isLogin: true,
  isWindows: false,
  showAiImage: false,
  ...overrides,
});

describe('account deletion search item', () => {
  const items = SETTINGS_SEARCH_ITEMS.filter((item) => item.labelKey === 'accountDeletion.title');

  it('lives only under Profile → Account, on the row anchor', () => {
    expect(items).toHaveLength(1);
    expect(items[0].tab).toBe(SettingsTabs.Profile);
    expect(items[0].anchor).toBe('profile-account-deletion');
  });

  it('is offered only to a signed-in user, like the row', () => {
    expect(items[0].visible?.(ctx())).toBe(true);
    expect(items[0].visible?.(ctx({ isLogin: false }))).toBe(false);
  });
});

describe('account deletion tab keywords', () => {
  const tabKeywords = (tab: SettingsTabs) => [
    ...(TAB_SEARCH_EN_KEYWORDS[tab] ?? []),
    ...defaultSetting[TAB_SEARCH_KEYWORDS_KEYS[tab] as keyof typeof defaultSetting].split(','),
  ];
  const mentionsDeletion = (keyword: string) => /account deletion|delete account/.test(keyword);

  it('sends a "delete account" search to Profile, not to Storage', () => {
    expect(tabKeywords(SettingsTabs.Profile).some(mentionsDeletion)).toBe(true);
    expect(tabKeywords(SettingsTabs.Storage).some(mentionsDeletion)).toBe(false);
  });
});
