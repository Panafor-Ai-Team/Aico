import { describe, expect, it, vi } from 'vitest';

import { getToolStoreState } from '@/store/tool';
import { toolSelectors } from '@/store/tool/selectors/tool';
import { ComposioServerStatus } from '@/store/tool/slices/composioStore';

import { activatorExecutor } from './lobe-activator';

vi.mock('@/store/tool', () => ({ getToolStoreState: vi.fn() }));
vi.mock('@/store/serverConfig', () => ({
  getServerConfigStoreState: () => ({ serverConfig: { enableComposio: true } }),
  serverConfigSelectors: { enableComposio: (s: any) => !!s.serverConfig.enableComposio },
}));
vi.mock('@/services/skill', () => ({
  agentSkillService: {
    getById: vi.fn(),
    getByName: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([]),
    readResource: vi.fn(),
  },
}));

const driveServer = {
  appSlug: 'GOOGLEDRIVE',
  authConfigId: 'ac_1',
  connectedAccountId: 'ca-1',
  createdAt: 0,
  identifier: 'google-drive',
  label: 'Google Drive',
  status: ComposioServerStatus.ACTIVE,
  tools: [
    { description: 'Find a file', inputSchema: { type: 'object' }, name: 'GOOGLEDRIVE_FIND_FILE' },
  ],
};

const ctx = { signal: new AbortController().signal } as any;

const storeState = (overrides: Record<string, unknown> = {}) =>
  ({
    agentSkills: [],
    builtinSkills: [],
    builtinTools: [],
    composioServers: [driveServer],
    connectors: [],
    ensureRuntimeToolsReady: vi.fn().mockResolvedValue(undefined),
    // The plugin list is fetched once at page load, so it has no entry for an
    // app connected afterwards.
    installedPlugins: [],
    lobehubSkillServers: [],
    ...overrides,
  }) as any;

// Regression: a Composio app connected in this session was listed in
// <available_tools> (from `composioServers`) but `activateTools` looked only in
// `installedPlugins`, so it answered "Not found" for the correct identifier.
describe('activator (browser) tool lookup', () => {
  it('activates a connected Composio app that is not in installedPlugins yet', async () => {
    vi.mocked(getToolStoreState).mockReturnValue(storeState());

    const result = await activatorExecutor.activateTools(
      {
        identifiers: ['google-drive'],
        reason: 'list files',
      } as any,
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.content).toContain('GOOGLEDRIVE_FIND_FILE');
    expect(result.content).not.toContain('Not found');
  });

  it('resolves every identifier it lists in <available_tools>', async () => {
    const state = storeState();
    vi.mocked(getToolStoreState).mockReturnValue(state);

    const listed = toolSelectors.availableToolsForDiscovery(state).map((t) => t.identifier);
    expect(listed).toContain('google-drive');

    const result = await activatorExecutor.activateTools(
      {
        identifiers: listed,
        reason: 'invariant',
      } as any,
      ctx,
    );

    expect((result.state as any).notFound).toEqual([]);
  });

  it('still reports an unknown identifier as not found', async () => {
    vi.mocked(getToolStoreState).mockReturnValue(storeState());

    const result = await activatorExecutor.activateTools(
      {
        identifiers: ['gdrive'],
        reason: 'guess',
      } as any,
      ctx,
    );

    expect((result.state as any).notFound).toEqual(['gdrive']);
  });

  // Regression: the chat page's menus are popup-scoped, so after a page load
  // nothing had fetched the Composio connections and `activateTools({ identifiers:
  // ['github'] })` answered "Not found: github" for a connected app.
  it('loads the connected apps before resolving when the store is still empty', async () => {
    const githubServer = {
      ...driveServer,
      appSlug: 'GITHUB',
      identifier: 'github',
      label: 'GitHub',
      tools: [{ description: 'List repos', inputSchema: { type: 'object' }, name: 'GITHUB_LIST' }],
    };
    let loaded = false;
    const ensureRuntimeToolsReady = vi.fn(async () => {
      loaded = true;
    });
    vi.mocked(getToolStoreState).mockImplementation(() =>
      storeState({ composioServers: loaded ? [githubServer] : [], ensureRuntimeToolsReady }),
    );

    const result = await activatorExecutor.activateTools(
      { identifiers: ['github'], reason: 'list repos' } as any,
      ctx,
    );

    expect(ensureRuntimeToolsReady).toHaveBeenCalledWith({ composio: true });
    expect((result.state as any).notFound).toEqual([]);
    expect(result.content).toContain('GITHUB_LIST');
  });

  // Regression: a custom MCP connector (e.g. Vercel added via OAuth) was never
  // listed in <available_tools> nor resolvable by `activateTools`, so unless the
  // user pinned it on the agent the model had no way to reach its tools and
  // answered "I don't have access to your account".
  describe('custom MCP connectors', () => {
    const vercelConnector = (overrides: Record<string, unknown> = {}) => ({
      id: 'conn-1',
      identifier: 'vercel',
      isEnabled: true,
      name: 'Vercel',
      sourceType: 'custom',
      status: 'connected',
      tools: [
        {
          description: 'List the projects of a team',
          inputSchema: { type: 'object' },
          permission: 'auto',
          toolName: 'list_projects',
        },
      ],
      ...overrides,
    });

    it('lists a connected custom connector and activates its tools', async () => {
      const state = storeState({ connectors: [vercelConnector()] });
      vi.mocked(getToolStoreState).mockReturnValue(state);

      const listed = toolSelectors.availableToolsForDiscovery(state);
      expect(listed.map((t) => t.identifier)).toContain('vercel');

      const result = await activatorExecutor.activateTools(
        { identifiers: ['vercel'], reason: 'list projects' } as any,
        ctx,
      );

      expect((result.state as any).notFound).toEqual([]);
      expect(result.content).toContain('list_projects');
    });

    it.each([
      ['disabled', { isEnabled: false }],
      ['not connected', { status: 'error' }],
      ['without synced tools', { tools: [] }],
      ['not custom', { sourceType: 'composio' }],
    ])('does not list a connector that is %s', (_label, overrides) => {
      const state = storeState({ connectors: [vercelConnector(overrides)] });
      const listed = toolSelectors.availableToolsForDiscovery(state).map((t) => t.identifier);
      expect(listed).not.toContain('vercel');
    });
  });
});
