import type { UpdateChannel } from '@lobechat/electron-client-ipc';

import { isDev } from '@/const/env';
import { getDesktopEnv } from '@/env';

// Build-time default channel, can be overridden at runtime via store
const rawChannel = getDesktopEnv().UPDATE_CHANNEL || 'stable';
export const coerceStoredUpdateChannel = (channel?: string | null): UpdateChannel =>
  channel === 'canary' ? 'canary' : 'stable';

/** Raw build channel for display (stable, canary, beta, or legacy nightly). */
export const BUILD_CHANNEL: string = rawChannel;
export const UPDATE_CHANNEL: UpdateChannel =
  rawChannel === 'canary' || rawChannel === 'beta' ? 'canary' : 'stable';

// S3 base URL for all channels
// e.g., https://releases.lobehub.com
// Each channel resolves to {base}/{channel}/
export const UPDATE_SERVER_URL = getDesktopEnv().UPDATE_SERVER_URL;

// GitHub repository used for updates when UPDATE_SERVER_URL is not set.
// Keep in sync with getPublishConfig() in apps/desktop/electron-builder.mjs.
export const GITHUB_UPDATE_REPO = { owner: 'Panafor-Ai-Team', repo: 'Aico' } as const;

export const updaterConfig = {
  app: {
    autoCheckUpdate: true,
    autoDownloadUpdate: true,
    checkUpdateInterval: 60 * 60 * 1000, // 1 hour
  },
  enableAppUpdate: !isDev,
};
