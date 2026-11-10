import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ComposioLib from '@/libs/composio';

import type * as CurateModule from './curate';
import { COMPOSIO_TOOLS_VERSION } from './curate';
import { ComposioService } from './index';

const mocks = vi.hoisted(() => ({
  connectorQuery: vi.fn(),
  connectorQueryByIdentifiers: vi.fn(),
  connectorToolDeleteNotIn: vi.fn(),
  connectorToolQueryAll: vi.fn(),
  connectorToolUpsertMany: vi.fn(),
  connectorUpdate: vi.fn(),
  fetchCurated: vi.fn(),
  isClientAvailable: vi.fn(),
  isComposioNotFound: vi.fn(),
  markComposioUnavailable: vi.fn(),
  pluginFindById: vi.fn(),
  pluginQuery: vi.fn(),
  pluginUpdate: vi.fn(),
  toolsExecute: vi.fn(),
}));

vi.mock('@/database/models/connector', () => ({
  ConnectorModel: vi.fn().mockImplementation(() => ({
    // Runtime resolution goes through the agent-aware resolvers; map them to the
    // same fixtures (the priority/dedup logic itself is covered by the model's
    // own connectorAgentScope tests).
    resolveAll: mocks.connectorQuery,
    resolveByIdentifiers: mocks.connectorQueryByIdentifiers,
    markComposioConnectionUnavailable: mocks.markComposioUnavailable,
    update: mocks.connectorUpdate,
  })),
}));

vi.mock('@/database/models/connectorTool', () => ({
  ConnectorToolModel: vi.fn().mockImplementation(() => ({
    deleteToolsNotIn: mocks.connectorToolDeleteNotIn,
    queryAllByConnectorIds: mocks.connectorToolQueryAll,
    upsertMany: mocks.connectorToolUpsertMany,
  })),
}));

vi.mock('@/database/models/plugin', () => ({
  PluginModel: vi.fn().mockImplementation(() => ({
    findById: mocks.pluginFindById,
    query: mocks.pluginQuery,
    update: mocks.pluginUpdate,
  })),
}));

vi.mock('@/libs/composio', async (importOriginal) => ({
  ...(await importOriginal<typeof ComposioLib>()),
  getComposioClient: () => ({ tools: { execute: mocks.toolsExecute } }),
  isComposioClientAvailable: mocks.isClientAvailable,
  isComposioConnectedAccountNotFoundError: mocks.isComposioNotFound,
}));

vi.mock('./curate', async (importOriginal) => ({
  ...(await importOriginal<typeof CurateModule>()),
  fetchCuratedComposioTools: mocks.fetchCurated,
}));

const service = () => new ComposioService({ db: {} as any, userId: 'user-1' });

const activeConnectorRow = (overrides: Record<string, any> = {}) => ({
  id: 'conn-gmail',
  identifier: 'gmail',
  isEnabled: true,
  metadata: {
    avatar: '🔌',
    composio: {
      appSlug: 'GMAIL',
      connectedAccountId: 'ca-connector',
      status: 'ACTIVE',
      toolsVersion: COMPOSIO_TOOLS_VERSION,
    },
  },
  name: 'Gmail',
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isClientAvailable.mockReturnValue(true);
  mocks.isComposioNotFound.mockImplementation(
    (error: unknown) =>
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'CONNECTED_ACCOUNT_NOT_FOUND',
  );
  mocks.markComposioUnavailable.mockResolvedValue(false);
  mocks.connectorQuery.mockResolvedValue([]);
  mocks.connectorQueryByIdentifiers.mockResolvedValue([]);
  mocks.connectorToolQueryAll.mockResolvedValue([]);
  mocks.pluginQuery.mockResolvedValue([]);
  mocks.pluginFindById.mockResolvedValue(undefined);
  mocks.connectorToolUpsertMany.mockResolvedValue(undefined);
  mocks.connectorToolDeleteNotIn.mockResolvedValue(undefined);
  mocks.connectorUpdate.mockResolvedValue(undefined);
});

describe('ComposioService.getComposioManifests', () => {
  it('builds manifests from connector rows + connector tools (new path)', async () => {
    mocks.connectorQuery.mockResolvedValue([activeConnectorRow()]);
    mocks.connectorToolQueryAll.mockResolvedValue([
      {
        description: 'Send an email',
        inputSchema: { properties: { to: {} }, type: 'object' },
        toolName: 'GMAIL_SEND_EMAIL',
        userConnectorId: 'conn-gmail',
      },
    ]);

    const manifests = await service().getComposioManifests();

    expect(manifests).toHaveLength(1);
    expect(manifests[0].identifier).toBe('gmail');
    expect(manifests[0].api).toHaveLength(1);
    expect(manifests[0].api[0].name).toBe('GMAIL_SEND_EMAIL');
    expect(manifests[0].api[0].parameters).toEqual({ properties: { to: {} }, type: 'object' });
    // Plugin table must NOT be consulted once the connector covers the identifier.
    expect(mocks.pluginQuery).toHaveBeenCalledTimes(1); // called, but yields nothing new
  });

  it('falls back to plugin table for identifiers without a connector projection', async () => {
    mocks.connectorQuery.mockResolvedValue([]);
    mocks.pluginQuery.mockResolvedValue([
      {
        customParams: { composio: { status: 'ACTIVE' } },
        identifier: 'slack',
        manifest: {
          api: [{ description: 'post', name: 'SLACK_POST', parameters: { type: 'object' } }],
          meta: { avatar: '☁️', title: 'Slack' },
        },
      },
    ]);

    const manifests = await service().getComposioManifests();

    expect(manifests).toHaveLength(1);
    expect(manifests[0].identifier).toBe('slack');
    expect(manifests[0].api[0].name).toBe('SLACK_POST');
  });

  it('unions both sources and dedupes by identifier (connector wins)', async () => {
    mocks.connectorQuery.mockResolvedValue([activeConnectorRow()]);
    mocks.connectorToolQueryAll.mockResolvedValue([
      { toolName: 'GMAIL_SEND_EMAIL', userConnectorId: 'conn-gmail' },
    ]);
    mocks.pluginQuery.mockResolvedValue([
      // Same identifier as the connector → must be dropped (connector wins).
      {
        customParams: { composio: { status: 'ACTIVE' } },
        identifier: 'gmail',
        manifest: { api: [{ name: 'GMAIL_OLD' }], meta: {} },
      },
      // Distinct identifier → included via fallback.
      {
        customParams: { composio: { status: 'ACTIVE' } },
        identifier: 'slack',
        manifest: { api: [{ name: 'SLACK_POST' }], meta: {} },
      },
    ]);

    const manifests = await service().getComposioManifests();

    expect(manifests.map((m) => m.identifier).sort()).toEqual(['gmail', 'slack']);
    const gmail = manifests.find((m) => m.identifier === 'gmail')!;
    // connector version (GMAIL_SEND_EMAIL), not the plugin's GMAIL_OLD
    expect(gmail.api[0].name).toBe('GMAIL_SEND_EMAIL');
  });

  it('ignores connector rows that are not ACTIVE or are disabled', async () => {
    mocks.connectorQuery.mockResolvedValue([
      activeConnectorRow({ metadata: { composio: { status: 'PENDING' } } }),
      activeConnectorRow({ id: 'c2', identifier: 'jira', isEnabled: false }),
    ]);

    const manifests = await service().getComposioManifests();

    expect(manifests).toHaveLength(0);
  });

  it('returns empty when there are no composio connections in either source', async () => {
    const manifests = await service().getComposioManifests();
    expect(manifests).toEqual([]);
  });
});

describe('ComposioService.getComposioManifests tool re-sync', () => {
  const staleGithub = (overrides: Record<string, any> = {}) =>
    activeConnectorRow({
      id: 'conn-github',
      identifier: 'github',
      metadata: {
        avatar: '🔌',
        composio: { appSlug: 'GITHUB', connectedAccountId: 'ca-gh', status: 'ACTIVE' },
      },
      name: 'GitHub',
      ...overrides,
    });

  it('re-syncs an ACTIVE connector saved before the tool set was versioned', async () => {
    mocks.connectorQuery.mockResolvedValue([staleGithub()]);
    mocks.fetchCurated.mockResolvedValue([
      {
        description: 'List my repos',
        inputParameters: { properties: {}, type: 'object' },
        slug: 'GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER',
      },
      { description: 'Create an issue', slug: 'GITHUB_CREATE_AN_ISSUE' },
    ]);

    await service().getComposioManifests();

    expect(mocks.fetchCurated).toHaveBeenCalledWith(expect.anything(), 'GITHUB');
    const [connectorId, rows] = mocks.connectorToolUpsertMany.mock.calls[0];
    expect(connectorId).toBe('conn-github');
    expect(rows.map((r: any) => [r.toolName, r.defaultPermission])).toEqual([
      ['GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER', 'auto'],
      ['GITHUB_CREATE_AN_ISSUE', 'needs_approval'],
    ]);
    expect(mocks.connectorToolDeleteNotIn).toHaveBeenCalledWith('conn-github', [
      'GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER',
      'GITHUB_CREATE_AN_ISSUE',
    ]);
    expect(mocks.connectorUpdate).toHaveBeenCalledWith('conn-github', {
      metadata: expect.objectContaining({
        composio: expect.objectContaining({ toolsVersion: COMPOSIO_TOOLS_VERSION }),
      }),
    });
  });

  // Regression: the browser builds its Composio tools from the plugin row's
  // manifest, so re-syncing only the connector tool rows never reached it.
  it("refreshes the plugin row's manifest with the re-synced tools", async () => {
    mocks.connectorQuery.mockResolvedValue([staleGithub({ id: 'conn-github-plugin' })]);
    mocks.pluginFindById.mockResolvedValue({
      identifier: 'github',
      manifest: { api: [{ name: 'OLD' }], identifier: 'github', meta: { title: 'GitHub' } },
    });
    mocks.fetchCurated.mockResolvedValue([
      { description: 'Find files', inputParameters: { type: 'object' }, slug: 'GITHUB_FIND_FILE' },
    ]);

    await service().getComposioManifests();

    expect(mocks.pluginUpdate).toHaveBeenCalledWith('github', {
      manifest: expect.objectContaining({
        api: [
          { description: 'Find files', name: 'GITHUB_FIND_FILE', parameters: { type: 'object' } },
        ],
        meta: { title: 'GitHub' },
      }),
    });
  });

  it('does not re-sync a connector already on the current tool version', async () => {
    mocks.connectorQuery.mockResolvedValue([activeConnectorRow()]);

    await service().getComposioManifests();

    expect(mocks.fetchCurated).not.toHaveBeenCalled();
    expect(mocks.connectorToolUpsertMany).not.toHaveBeenCalled();
  });

  it('keeps the saved tools when the re-sync fails, and does not stamp the version', async () => {
    mocks.connectorQuery.mockResolvedValue([staleGithub({ id: 'conn-github-fail' })]);
    mocks.connectorToolQueryAll.mockResolvedValue([
      { toolName: 'GITHUB_OLD_TOOL', userConnectorId: 'conn-github-fail' },
    ]);
    mocks.fetchCurated.mockRejectedValue(new Error('composio down'));

    const manifests = await service().getComposioManifests();

    expect(manifests).toHaveLength(1);
    expect(manifests[0].api[0].name).toBe('GITHUB_OLD_TOOL');
    expect(mocks.connectorToolDeleteNotIn).not.toHaveBeenCalled();
    expect(mocks.connectorUpdate).not.toHaveBeenCalled();
  });

  it('never wipes the saved tools when Composio returns an empty list', async () => {
    mocks.connectorQuery.mockResolvedValue([staleGithub({ id: 'conn-github-empty' })]);
    mocks.fetchCurated.mockResolvedValue([]);

    await service().getComposioManifests();

    expect(mocks.connectorToolDeleteNotIn).not.toHaveBeenCalled();
    expect(mocks.connectorUpdate).not.toHaveBeenCalled();
  });

  it("tells the model the integration is the user's own connected account", async () => {
    mocks.connectorQuery.mockResolvedValue([activeConnectorRow()]);
    mocks.connectorToolQueryAll.mockResolvedValue([
      { toolName: 'GMAIL_SEND_EMAIL', userConnectorId: 'conn-gmail' },
    ]);

    const [manifest] = await service().getComposioManifests();

    expect(manifest.meta.description).toContain("user's own Gmail account");
    expect(manifest.meta.description).toContain('do not use web search');
  });
});

describe('ComposioService.resyncStaleConnections', () => {
  it('re-syncs only ACTIVE, enabled connectors that are behind', async () => {
    const stale = (id: string, overrides: Record<string, any> = {}) =>
      activeConnectorRow({
        id,
        identifier: id,
        metadata: {
          composio: { appSlug: id.toUpperCase(), connectedAccountId: `ca-${id}`, status: 'ACTIVE' },
        },
        ...overrides,
      });
    mocks.connectorQuery.mockResolvedValue([
      stale('googledrive'),
      stale('airtable', { isEnabled: false }),
      stale('zendesk', {
        metadata: {
          composio: { appSlug: 'ZENDESK', connectedAccountId: 'ca-z', status: 'PENDING' },
        },
      }),
    ]);
    mocks.fetchCurated.mockResolvedValue([{ slug: 'GOOGLEDRIVE_FIND_FILE' }]);

    await service().resyncStaleConnections();

    expect(mocks.fetchCurated).toHaveBeenCalledTimes(1);
    expect(mocks.fetchCurated).toHaveBeenCalledWith(expect.anything(), 'GOOGLEDRIVE');
  });

  it('never throws when the connector lookup fails', async () => {
    mocks.connectorQuery.mockRejectedValue(new Error('db down'));

    await expect(service().resyncStaleConnections()).resolves.toBeUndefined();
  });
});

describe('ComposioService.executeComposioTool', () => {
  const params = { args: { to: 'a@b.c' }, identifier: 'gmail', toolSlug: 'GMAIL_SEND_EMAIL' };

  it('returns COMPOSIO_NOT_CONFIGURED when the client is unavailable', async () => {
    mocks.isClientAvailable.mockReturnValue(false);

    const result = await service().executeComposioTool(params);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('COMPOSIO_NOT_CONFIGURED');
    expect(mocks.toolsExecute).not.toHaveBeenCalled();
  });

  it('resolves connectedAccountId from connector metadata (new path)', async () => {
    mocks.connectorQueryByIdentifiers.mockResolvedValue([activeConnectorRow()]);
    mocks.toolsExecute.mockResolvedValue({ data: 'sent' });

    const result = await service().executeComposioTool(params);

    expect(result.success).toBe(true);
    expect(result.content).toBe('sent');
    expect(mocks.toolsExecute).toHaveBeenCalledWith(
      'GMAIL_SEND_EMAIL',
      expect.objectContaining({ connectedAccountId: 'ca-connector', userId: 'user-1' }),
    );
    // connector hit → plugin fallback not consulted
    expect(mocks.pluginFindById).not.toHaveBeenCalled();
  });

  /**
   * @example
   * expect(connector.status).toBe('error');
   */
  it('delegates a connected-account 404 to ConnectorModel after tool execution fails', async () => {
    const notFound = Object.assign(new Error('connected account not found'), {
      code: 'CONNECTED_ACCOUNT_NOT_FOUND',
    });
    mocks.connectorQueryByIdentifiers.mockResolvedValue([activeConnectorRow()]);
    mocks.toolsExecute.mockRejectedValue(notFound);
    mocks.markComposioUnavailable.mockResolvedValue(true);

    const result = await service().executeComposioTool(params);

    expect(result.success).toBe(false);
    expect(mocks.markComposioUnavailable).toHaveBeenCalledWith('conn-gmail', 'ca-connector');
  });

  /**
   * @example
   * expect(connector.status).toBe('connected');
   */
  it('does not disable a connector when a tool reports a remote resource 404', async () => {
    // ROOT CAUSE:
    //
    // A generic HTTP 404 can mean the requested email, repository, or other provider resource is
    // missing. Treating every 404 as a missing Composio connected account disabled healthy connectors.
    // We now require Composio's explicit connected-account-not-found classification at this boundary.
    mocks.connectorQueryByIdentifiers.mockResolvedValue([activeConnectorRow()]);
    mocks.toolsExecute.mockRejectedValue(
      Object.assign(new Error('repository not found'), { status: 404 }),
    );

    const result = await service().executeComposioTool(params);

    expect(result.success).toBe(false);
    expect(mocks.markComposioUnavailable).not.toHaveBeenCalled();
  });

  // Regression: Composio resolves a failed upstream call (e.g. GitHub 404) as
  // `{ successful: false, error }`; it was returned as a success with the error
  // text dropped, so the model only saw an opaque "not found".
  it("returns a failure with Composio's error when the tool call was not successful", async () => {
    mocks.connectorQueryByIdentifiers.mockResolvedValue([activeConnectorRow()]);
    mocks.toolsExecute.mockResolvedValue({ data: {}, error: 'Not Found', successful: false });

    const result = await service().executeComposioTool(params);

    expect(result.success).toBe(false);
    expect(result.content).toBe('Not Found');
    expect(result.error).toEqual({ code: 'COMPOSIO_TOOL_FAILED', message: 'Not Found' });
  });

  it('executes under the account OWNER entity, not the caller (workspace-shared connector)', async () => {
    // Regression: a workspace member runs a shared agent whose Composio connector
    // was linked by another user (openomy). buildWorkspaceWhere resolves that
    // owner's row; the connected account is bound to the owner's Composio entity,
    // so execute MUST pass the owner's userId — passing the caller's ('user-1')
    // failed Composio's account/entity validation ("Error executing the tool").
    mocks.connectorQueryByIdentifiers.mockResolvedValue([
      activeConnectorRow({ userId: 'owner-openomy' }),
    ]);
    mocks.toolsExecute.mockResolvedValue({ data: 'sent' });

    const result = await service().executeComposioTool(params);

    expect(result.success).toBe(true);
    expect(mocks.toolsExecute).toHaveBeenCalledWith(
      'GMAIL_SEND_EMAIL',
      expect.objectContaining({ connectedAccountId: 'ca-connector', userId: 'owner-openomy' }),
    );
  });

  it('prefers metadata.composio.linkedByUserId over the row creator (owner reconnected a member row)', async () => {
    // A workspace owner reconnected Gmail on a member-created connector row:
    // upsertComposioConnector refreshes metadata (incl. linkedByUserId=owner) but
    // keeps userId=member (the row creator, for manage-rights). The account is now
    // linked under the owner, so execute must run under linkedByUserId, NOT userId.
    mocks.connectorQueryByIdentifiers.mockResolvedValue([
      activeConnectorRow({
        metadata: {
          composio: {
            connectedAccountId: 'ca-connector',
            linkedByUserId: 'owner-reconnector',
            status: 'ACTIVE',
          },
        },
        userId: 'member-creator',
      }),
    ]);
    mocks.toolsExecute.mockResolvedValue({ data: 'sent' });

    const result = await service().executeComposioTool(params);

    expect(result.success).toBe(true);
    expect(mocks.toolsExecute).toHaveBeenCalledWith(
      'GMAIL_SEND_EMAIL',
      expect.objectContaining({ connectedAccountId: 'ca-connector', userId: 'owner-reconnector' }),
    );
  });

  it('falls back to plugin customParams when the connector has no account', async () => {
    mocks.connectorQueryByIdentifiers.mockResolvedValue([]);
    mocks.pluginFindById.mockResolvedValue({
      customParams: { composio: { connectedAccountId: 'ca-plugin' } },
      userId: 'owner-plugin',
    });
    mocks.toolsExecute.mockResolvedValue({ data: 'sent' });

    const result = await service().executeComposioTool(params);

    expect(result.success).toBe(true);
    expect(mocks.toolsExecute).toHaveBeenCalledWith(
      'GMAIL_SEND_EMAIL',
      expect.objectContaining({ connectedAccountId: 'ca-plugin', userId: 'owner-plugin' }),
    );
  });

  it('returns COMPOSIO_CONFIG_NOT_FOUND when neither source has an account', async () => {
    mocks.connectorQueryByIdentifiers.mockResolvedValue([]);
    mocks.pluginFindById.mockResolvedValue(undefined);

    const result = await service().executeComposioTool(params);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('COMPOSIO_CONFIG_NOT_FOUND');
    expect(mocks.toolsExecute).not.toHaveBeenCalled();
  });
});
