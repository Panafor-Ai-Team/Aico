import { describe, expect, it, vi } from 'vitest';

import { getToolStoreState } from '@/store/tool';
import { toolSelectors } from '@/store/tool/selectors/tool';
import { ComposioServerStatus } from '@/store/tool/slices/composioStore';

import { activatorExecutor } from './lobe-activator';

vi.mock('@/store/tool', () => ({ getToolStoreState: vi.fn() }));
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
});
