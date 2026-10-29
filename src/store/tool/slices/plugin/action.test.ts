import { type LobeTool } from '@lobechat/types';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { pluginService } from '@/services/plugin';
import { merge } from '@/utils/merge';

import { useToolStore } from '../../store';

vi.mock('@/services/plugin', () => ({
  pluginService: {
    getInstalledPlugins: vi.fn().mockResolvedValue([]),
    updatePluginSettings: vi.fn(),
  },
}));

beforeEach(() => {
  // Reset all mocks before each test
  vi.resetAllMocks();
});

describe('useToolStore:plugin', () => {
  describe('checkPluginsIsInstalled', () => {
    it('should be deprecated and do nothing', async () => {
      // Old plugin system has been deprecated
      const { result } = renderHook(() => useToolStore());

      await act(async () => {
        await result.current.checkPluginsIsInstalled(['plugin1', 'plugin2']);
      });

      // Should not call any methods since old plugin system is deprecated
    });
  });

  describe('updatePluginSettings', () => {
    it('should update settings for a given plugin', async () => {
      const pluginId = 'test-plugin';
      const newSettings = { setting1: 'new-value' };

      const { result } = renderHook(() => useToolStore());

      await act(async () => {
        await result.current.updatePluginSettings(pluginId, newSettings);
      });

      expect(pluginService.updatePluginSettings).toBeCalledWith(
        pluginId,
        newSettings,
        expect.any(AbortSignal),
      );
    });

    it('should merge settings for a plugin with existing settings', async () => {
      const pluginId = 'test-plugin';
      const existingSettings = { setting1: 'old-value', setting2: 'old-value' };
      const newSettings = { setting1: 'new-value' };
      const mergedSettings = merge(existingSettings, newSettings);
      useToolStore.setState({
        installedPlugins: [{ identifier: pluginId, settings: existingSettings }] as LobeTool[],
      });

      const { result } = renderHook(() => useToolStore());

      await act(async () => {
        await result.current.updatePluginSettings(pluginId, newSettings);
      });

      expect(pluginService.updatePluginSettings).toBeCalledWith(
        pluginId,
        mergedSettings,
        expect.any(AbortSignal),
      );
    });
  });

  describe('validatePluginSettings', () => {
    // 模拟插件数据
    const testPluginId = 'test-plugin';
    // 定义测试用的 schema 和模拟的验证结果
    const testSchema = {
      properties: { abc: { type: 'string' } },
      required: ['abc'],
      type: 'object',
    };

    const testPluginSettings = { abc: 'valid-string' };

    const testPlugin = {
      type: 'plugin',
      identifier: testPluginId,
      manifest: {
        identifier: testPluginId,
        settings: testSchema,
      },
      settings: testPluginSettings,
    } as unknown as LobeTool;

    it('should validate settings against the schema and return valid result', async () => {
      const { result } = renderHook(() => useToolStore());

      act(() => {
        useToolStore.setState({
          installedPlugins: [testPlugin],
        });
      });

      const validationResult = await result.current.validatePluginSettings(testPluginId);

      expect(validationResult).toEqual({ valid: true, errors: [] });
    });

    it('should return invalid result if settings do not match the schema', async () => {
      const { result } = renderHook(() => useToolStore());
      act(() => {
        useToolStore.setState({
          installedPlugins: [{ ...testPlugin, settings: {} }] as any,
        });
      });

      const validationResult = await result.current.validatePluginSettings(testPluginId);

      expect(validationResult).toMatchSnapshot();
    });

    it('should return undefined if manifest or settings are not found', async () => {
      useToolStore.setState({
        installedPlugins: [],
      });

      const { result } = renderHook(() => useToolStore());

      const validationResult = await result.current.validatePluginSettings(testPluginId);

      expect(validationResult).toBeUndefined();
    });
  });
});

// Regression: the chat page's menus are popup-scoped, so a run started right
// after a page load built its tool set from an empty store — every connected
// app and installed plugin was missing ("Not found: github").
describe('ensureRuntimeToolsReady', () => {
  beforeEach(() => {
    useToolStore.setState({
      installedPlugins: [],
      isComposioServersInit: false,
      loadingInstallPlugins: true,
    });
  });

  it('loads installed plugins and Composio connections that are not loaded yet', async () => {
    const plugins = [{ identifier: 'my-mcp' }] as LobeTool[];
    vi.mocked(pluginService.getInstalledPlugins).mockResolvedValue(plugins);
    const refreshComposioConnections = vi.fn().mockResolvedValue(undefined);
    useToolStore.setState({ refreshComposioConnections });

    await act(async () => {
      await useToolStore.getState().ensureRuntimeToolsReady({ composio: true });
    });

    expect(useToolStore.getState().installedPlugins).toEqual(plugins);
    expect(useToolStore.getState().loadingInstallPlugins).toBe(false);
    expect(refreshComposioConnections).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the tool state is already loaded', async () => {
    const refreshComposioConnections = vi.fn();
    useToolStore.setState({
      isComposioServersInit: true,
      loadingInstallPlugins: false,
      refreshComposioConnections,
    });

    await useToolStore.getState().ensureRuntimeToolsReady({ composio: true });

    expect(pluginService.getInstalledPlugins).not.toHaveBeenCalled();
    expect(refreshComposioConnections).not.toHaveBeenCalled();
  });

  it('skips Composio when it is not enabled', async () => {
    vi.mocked(pluginService.getInstalledPlugins).mockResolvedValue([]);
    const refreshComposioConnections = vi.fn();
    useToolStore.setState({ refreshComposioConnections });

    await useToolStore.getState().ensureRuntimeToolsReady();

    expect(refreshComposioConnections).not.toHaveBeenCalled();
  });

  it('gives up after the timeout so a slow request cannot stall the send', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(pluginService.getInstalledPlugins).mockReturnValue(new Promise(() => {}));

      const ready = useToolStore.getState().ensureRuntimeToolsReady({ timeoutMs: 50 });
      await vi.advanceTimersByTimeAsync(50);

      await expect(ready).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not throw when a load fails', async () => {
    vi.mocked(pluginService.getInstalledPlugins).mockRejectedValue(new Error('offline'));

    await expect(useToolStore.getState().ensureRuntimeToolsReady()).resolves.toBeUndefined();
    expect(useToolStore.getState().loadingInstallPlugins).toBe(true);
  });
});
