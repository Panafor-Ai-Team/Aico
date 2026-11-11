import { afterEach, describe, expect, it } from 'vitest';

import {
  HOME_CUSTOMIZE_DEFAULTS_VERSION,
  HOME_PRESETS,
} from '@/features/Home/CustomizeModal/config';

import { createInitialSystemStatus, INITIAL_STATUS } from './initialState';

const STORAGE_KEY = 'LOBE_SYSTEM_STATUS';

const seed = (value: unknown) => localStorage.setItem(STORAGE_KEY, JSON.stringify(value));

afterEach(() => {
  localStorage.removeItem(STORAGE_KEY);
});

describe('createInitialSystemStatus', () => {
  it('restores the shell-defining preferences synchronously', () => {
    seed({ leftPanelWidth: 360, showHomeRail: false, showLeftPanel: false });

    const status = createInitialSystemStatus();

    expect(status.leftPanelWidth).toBe(360);
    expect(status.showHomeRail).toBe(false);
    expect(status.showLeftPanel).toBe(false);
  });

  it('restores the Home customizations that decide layout on first paint', () => {
    seed({
      hiddenHomeWidgets: ['news', 'suggestions'],
      homeCustomizeVersion: HOME_CUSTOMIZE_DEFAULTS_VERSION,
      showHomePortrait: false,
    });

    const status = createInitialSystemStatus();

    expect(status.showHomePortrait).toBe(false);
    expect(status.hiddenHomeWidgets).toEqual(['news', 'suggestions']);
  });

  it('moves a Home saved before the minimal default onto it, once', () => {
    seed({ hiddenHomeWidgets: [], showHomePortrait: true });

    const migrated = createInitialSystemStatus();
    expect(migrated.hiddenHomeWidgets).toEqual([...HOME_PRESETS.minimal.hiddenWidgets]);
    expect(migrated.showHomePortrait).toBe(false);
    expect(migrated.homeCustomizeVersion).toBe(HOME_CUSTOMIZE_DEFAULTS_VERSION);

    // A choice made after the migration is preserved on the next boot.
    seed(migrated);
    const reloaded = createInitialSystemStatus();
    expect(reloaded.hiddenHomeWidgets).toEqual([...HOME_PRESETS.minimal.hiddenWidgets]);

    seed({ ...migrated, hiddenHomeWidgets: [], showHomePortrait: true });
    const choseFull = createInitialSystemStatus();
    expect(choseFull.hiddenHomeWidgets).toEqual([]);
    expect(choseFull.showHomePortrait).toBe(true);
  });

  it('falls back to defaults when nothing is persisted', () => {
    const status = createInitialSystemStatus();

    expect(status.leftPanelWidth).toBe(INITIAL_STATUS.leftPanelWidth);
    expect(status.showHomeRail).toBe(INITIAL_STATUS.showHomeRail);
    expect(status.showLeftPanel).toBe(INITIAL_STATUS.showLeftPanel);
    expect(status.showHomePortrait).toBe(INITIAL_STATUS.showHomePortrait);
    expect(status.hiddenHomeWidgets).toEqual(INITIAL_STATUS.hiddenHomeWidgets);
  });

  it('defaults the Home switches to the minimal preset', () => {
    const status = createInitialSystemStatus();

    expect(status.showHomePortrait).toBe(HOME_PRESETS.minimal.showPortrait);
    expect(status.hiddenHomeWidgets).toEqual([...HOME_PRESETS.minimal.hiddenWidgets]);
  });

  it('ignores persisted values of the wrong type', () => {
    seed({
      hiddenHomeWidgets: 'news',
      leftPanelWidth: '360',
      showHomePortrait: 'false',
      showLeftPanel: 'false',
    });

    const status = createInitialSystemStatus();

    expect(status.leftPanelWidth).toBe(INITIAL_STATUS.leftPanelWidth);
    expect(status.showLeftPanel).toBe(INITIAL_STATUS.showLeftPanel);
    expect(status.showHomePortrait).toBe(INITIAL_STATUS.showHomePortrait);
    expect(status.hiddenHomeWidgets).toEqual(INITIAL_STATUS.hiddenHomeWidgets);
  });

  it('survives a corrupted payload', () => {
    localStorage.setItem(STORAGE_KEY, '{not json');

    expect(createInitialSystemStatus().leftPanelWidth).toBe(INITIAL_STATUS.leftPanelWidth);
  });
});
