import { afterEach, describe, expect, it } from 'vitest';

import {
  filterToolIdsByCurrentEnv,
  isInstalledPluginAvailableInCurrentEnv,
  isToolAvailableInCurrentEnv,
} from './toolAvailability';

const setCloudSandboxBackend = (enableCloudSandbox?: boolean) => {
  (window as any).global_serverConfigStore = {
    getState: () => ({ serverConfig: { enableCloudSandbox } }),
  };
};

afterEach(() => {
  delete (window as any).global_serverConfigStore;
});

describe('toolAvailability', () => {
  it('should hide desktop-only builtin skills in web', () => {
    expect(
      filterToolIdsByCurrentEnv(['lobe-agent-browser', 'lobe-web-browsing'], { isDesktop: false }),
    ).toEqual(['lobe-web-browsing']);
  });

  it('should hide stdio mcp plugins in web', () => {
    expect(
      filterToolIdsByCurrentEnv(['local-mcp', 'remote-mcp'], {
        installedPlugins: [
          {
            customParams: { mcp: { type: 'stdio' } },
            identifier: 'local-mcp',
          },
        ],
        isDesktop: false,
      }),
    ).toEqual(['remote-mcp']);
  });

  it('should keep deprecated tool ids visible for cleanup', () => {
    expect(filterToolIdsByCurrentEnv(['deleted-plugin'], { isDesktop: false })).toEqual([
      'deleted-plugin',
    ]);
  });

  it('should mark stdio mcp plugins as unavailable in web', () => {
    expect(
      isInstalledPluginAvailableInCurrentEnv(
        { customParams: { mcp: { type: 'stdio' } }, identifier: 'local-mcp' },
        { isDesktop: false },
      ),
    ).toBe(false);
  });

  it('should mark desktop-only builtin tools as unavailable in web when injected', () => {
    expect(
      isToolAvailableInCurrentEnv('lobe-agent-browser', {
        installedPlugins: [],
        isDesktop: false,
      }),
    ).toBe(false);
  });

  // Regression: on a deployment with no sandbox backend every cloud sandbox
  // call 401s, and the activator resolves tools through this same check — so an
  // unavailable sandbox must be dropped here or it stays discoverable.
  it('should drop the cloud sandbox tool when the deployment has no sandbox backend', () => {
    setCloudSandboxBackend(false);

    expect(isToolAvailableInCurrentEnv('lobe-cloud-sandbox')).toBe(false);
  });

  it('should keep the cloud sandbox tool when the deployment has a sandbox backend', () => {
    setCloudSandboxBackend(true);

    expect(isToolAvailableInCurrentEnv('lobe-cloud-sandbox')).toBe(true);
  });
});
