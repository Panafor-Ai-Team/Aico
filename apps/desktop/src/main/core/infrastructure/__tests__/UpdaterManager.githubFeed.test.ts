import { autoUpdater } from 'electron-updater';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as UpdaterConfigs from '@/modules/updater/configs';

import type { App as AppCore } from '../../App';
import { UpdaterManager } from '../UpdaterManager';

vi.mock('electron-log', () => ({
  default: {
    transports: {
      file: { getFile: vi.fn().mockReturnValue({ path: '/mock/log/path' }), level: 'info' },
    },
  },
}));

vi.mock('electron-updater', () => ({
  autoUpdater: {
    allowDowngrade: false,
    allowPrerelease: false,
    autoDownload: false,
    autoInstallOnAppQuit: false,
    channel: 'stable',
    checkForUpdates: vi.fn(),
    forceDevUpdateConfig: false,
    logger: null as any,
    on: vi.fn(),
    setFeedURL: vi.fn(),
  },
}));

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn().mockReturnValue([]) },
  app: { getVersion: vi.fn().mockReturnValue('0.0.0'), releaseSingleInstanceLock: vi.fn() },
}));

vi.mock('@/utils/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

// No UPDATE_SERVER_URL: the build publishes to GitHub Releases.
vi.mock('@/modules/updater/configs', async (importOriginal) => {
  const actual = await importOriginal<typeof UpdaterConfigs>();
  return {
    ...actual,
    UPDATE_CHANNEL: 'stable',
    UPDATE_SERVER_URL: undefined,
    updaterConfig: {
      app: { autoCheckUpdate: false, autoDownloadUpdate: true, checkUpdateInterval: 3_600_000 },
      enableAppUpdate: true,
    },
  };
});

vi.mock('@/env', () => ({
  getDesktopEnv: () => ({ FORCE_DEV_UPDATE_CONFIG: false }),
}));

vi.mock('@/const/env', () => ({ isDev: false }));

describe('UpdaterManager GitHub feed', () => {
  let updaterManager: UpdaterManager;

  beforeEach(() => {
    vi.clearAllMocks();
    const mockApp = {
      browserManager: { getMainWindow: vi.fn().mockReturnValue({ broadcast: vi.fn() }) },
      isQuiting: false,
      menuManager: { rebuildAppMenu: vi.fn() },
      storeManager: { get: vi.fn().mockReturnValue('stable'), set: vi.fn() },
    } as unknown as AppCore;
    updaterManager = new UpdaterManager(mockApp);
  });

  it('checks for updates on the Panachat repository, not upstream LobeHub', async () => {
    await updaterManager.initialize();

    expect(autoUpdater.setFeedURL).toHaveBeenCalledWith({
      owner: 'Panafor-Ai-Team',
      provider: 'github',
      repo: 'Aico',
    });
  });
});
