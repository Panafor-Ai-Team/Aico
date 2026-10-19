import { renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { initServerConfigStore, Provider } from '@/store/serverConfig/store';
import { useToolStore } from '@/store/tool';

import { useControls } from './useControls';

const fetchLobehubSkillConnections = vi.fn();
const noop = vi.fn();

vi.mock('@/hooks/useCheckPluginsIsInstalled', () => ({ useCheckPluginsIsInstalled: vi.fn() }));
vi.mock('@/hooks/useFetchInstalledPlugins', () => ({ useFetchInstalledPlugins: vi.fn() }));
vi.mock('@/hooks/usePermission', () => ({ usePermission: () => ({ allowed: true }) }));
vi.mock('@/features/SkillStore', () => ({ createSkillStoreModal: vi.fn() }));
vi.mock('@/features/Connectors/CustomConnectorModal/imperative', () => ({
  openConnectorEditDrawer: vi.fn(),
}));
vi.mock('@/features/PluginDevModal/imperative', () => ({ openPluginEditDrawer: vi.fn() }));
vi.mock('@/features/Workspace/useWorkspaceAwareNavigate', () => ({
  useWorkspaceAwareNavigate: () => vi.fn(),
}));
vi.mock('../../hooks/useAgentId', () => ({ useAgentId: () => 'agent-id' }));
vi.mock('../../hooks/useUpdateAgentConfig', () => ({
  useUpdateAgentConfig: () => ({ updateAgentChatConfig: vi.fn(), updateAgentConfig: vi.fn() }),
}));

let serverConfigStore = initServerConfigStore({});

const createWrapper = () => {
  const Wrapper = ({ children }: { children: ReactNode }) =>
    createElement(Provider, { createStore: () => serverConfigStore }, children);

  return Wrapper;
};

describe('useControls', () => {
  beforeEach(() => {
    fetchLobehubSkillConnections.mockClear();
    noop.mockClear();

    serverConfigStore = initServerConfigStore({});
    serverConfigStore.setState({
      serverConfig: { ...serverConfigStore.getState().serverConfig, enableLobehubSkill: true },
    });

    useToolStore.setState({
      fetchConnectors: noop,
      isConnectorsInit: true,
      useFetchAgentSkills: noop,
      useFetchLobehubSkillConnections: fetchLobehubSkillConnections,
      useFetchUninstalledBuiltinTools: noop,
      useFetchUserComposioConnections: noop,
    });
  });

  it('fetches LobeHub Skill connections only after the popover opens', () => {
    const { rerender } = renderHook(({ open }: { open: boolean }) => useControls({ open }), {
      initialProps: { open: false },
      wrapper: createWrapper(),
    });

    expect(fetchLobehubSkillConnections).toHaveBeenLastCalledWith(false);

    rerender({ open: true });

    expect(fetchLobehubSkillConnections).toHaveBeenLastCalledWith(true);
  });
});
