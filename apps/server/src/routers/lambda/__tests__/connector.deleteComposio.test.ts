// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentModel } from '@/database/models/agent';
import { ConnectorModel } from '@/database/models/connector';
import { ConnectorToolModel } from '@/database/models/connectorTool';
import { PluginModel } from '@/database/models/plugin';
import type * as ComposioLib from '@/libs/composio';

import { connectorRouter } from '../connector';

const { connectedAccountsDelete } = vi.hoisted(() => ({ connectedAccountsDelete: vi.fn() }));

// `vi.mock` is hoisted above the imports at runtime, so the mocks are active
// when the router module is evaluated. Kept below the imports to satisfy
// `import-x/first`.
vi.mock('@/database/models/agent', () => ({ AgentModel: vi.fn() }));
vi.mock('@/database/models/connector', () => ({ ConnectorModel: vi.fn() }));
vi.mock('@/database/models/connectorTool', () => ({ ConnectorToolModel: vi.fn() }));
vi.mock('@/database/models/plugin', () => ({ PluginModel: vi.fn() }));
vi.mock('@/server/modules/KeyVaultsEncrypt', () => ({
  KeyVaultsGateKeeper: { initWithEnvKey: async () => ({}) },
}));
vi.mock('@/libs/composio', async (importOriginal) => ({
  ...(await importOriginal<typeof ComposioLib>()),
  getComposioClient: () => ({ connectedAccounts: { delete: connectedAccountsDelete } }),
  isComposioClientAvailable: () => true,
}));
vi.mock('@/business/server/trpc-middlewares/workspaceAuth', async () => {
  const mod = await vi.importActual<{ trpc: any }>('@/libs/trpc/lambda/init');
  // The real `wsCompatProcedure` validates a Better-Auth session; for unit
  // tests we skip auth and rely on the test ctx already carrying `userId`.
  return {
    requireWorkspaceRoleWhenScoped: () => mod.trpc.middleware(async (opts: any) => opts.next()),
    wsCompatProcedure: mod.trpc.procedure,
  };
});
vi.mock('@/libs/trpc/lambda/middleware', () => ({
  serverDatabase: async (opts: any) =>
    opts.next({ ctx: { ...opts.ctx, serverDB: opts.ctx.serverDB ?? {} } }),
}));

// Regression: "Uninstall" on a connected Composio app deleted only the DB rows.
// The Composio account stayed ACTIVE (token alive), and Composio then refused
// every new link for that user, so Connect did nothing.
describe('connectorRouter.delete — Composio connectors', () => {
  const CONNECTOR_ID = '00000000-0000-4000-8000-000000000001';
  let connectorModelMock: any;

  beforeEach(() => {
    vi.clearAllMocks();
    connectorModelMock = { delete: vi.fn(), findById: vi.fn() };
    vi.mocked(ConnectorModel).mockImplementation(() => connectorModelMock);
    vi.mocked(ConnectorToolModel).mockImplementation(() => ({}) as any);
    vi.mocked(PluginModel).mockImplementation(() => ({}) as any);
    vi.mocked(AgentModel).mockImplementation(() => ({}) as any);
  });

  const caller = () =>
    connectorRouter.createCaller({ serverDB: {}, userId: 'user_test', workspaceId: null } as any);

  const composioRow = {
    agentId: null,
    id: CONNECTOR_ID,
    identifier: 'github',
    metadata: { composio: { appSlug: 'GITHUB', connectedAccountId: 'ca-1', status: 'ACTIVE' } },
    userId: 'user_test',
  };

  it('revokes the Composio account before deleting the row', async () => {
    connectorModelMock.findById.mockResolvedValue(composioRow);

    await caller().delete({ id: CONNECTOR_ID });

    expect(connectedAccountsDelete).toHaveBeenCalledWith('ca-1');
    expect(connectorModelMock.delete).toHaveBeenCalledWith(CONNECTOR_ID);
    expect(connectedAccountsDelete.mock.invocationCallOrder[0]).toBeLessThan(
      connectorModelMock.delete.mock.invocationCallOrder[0],
    );
  });

  it('keeps the row when revoking fails', async () => {
    connectorModelMock.findById.mockResolvedValue(composioRow);
    connectedAccountsDelete.mockRejectedValue(new Error('Composio down'));

    await expect(caller().delete({ id: CONNECTOR_ID })).rejects.toThrow();

    expect(connectorModelMock.delete).not.toHaveBeenCalled();
  });

  it('deletes the row when the account is already gone', async () => {
    connectorModelMock.findById.mockResolvedValue(composioRow);
    connectedAccountsDelete.mockRejectedValue(
      Object.assign(new Error('Not found'), { status: 404 }),
    );

    await caller().delete({ id: CONNECTOR_ID });

    expect(connectorModelMock.delete).toHaveBeenCalledWith(CONNECTOR_ID);
  });

  it('does not touch Composio for a non-Composio connector', async () => {
    connectorModelMock.findById.mockResolvedValue({ ...composioRow, metadata: {} });

    await caller().delete({ id: CONNECTOR_ID });

    expect(connectedAccountsDelete).not.toHaveBeenCalled();
    expect(connectorModelMock.delete).toHaveBeenCalledWith(CONNECTOR_ID);
  });
});
