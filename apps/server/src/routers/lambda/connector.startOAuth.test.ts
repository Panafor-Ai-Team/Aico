// @vitest-environment node
import { ServerError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { connectorRouter } from './connector';

const mocks = vi.hoisted(() => ({
  buildAuthorizationUrl: vi.fn(),
  connectorFindById: vi.fn(),
  connectorUpdate: vi.fn(),
  discoverConnectorOAuth: vi.fn(),
  getClientMetadataUrl: vi.fn(),
  registerDynamicClient: vi.fn(),
  saveState: vi.fn(),
}));

vi.mock('@/database/core/db-adaptor', () => ({ getServerDB: vi.fn(async () => ({})) }));
vi.mock('@/server/modules/KeyVaultsEncrypt', () => ({
  KeyVaultsGateKeeper: { initWithEnvKey: vi.fn(async () => ({})) },
}));
vi.mock('@/database/models/connector', () => ({
  ConnectorModel: vi.fn().mockImplementation(() => ({
    findById: mocks.connectorFindById,
    update: mocks.connectorUpdate,
  })),
}));
vi.mock('@/database/models/connectorTool', () => ({ ConnectorToolModel: vi.fn() }));
vi.mock('@/database/models/plugin', () => ({ PluginModel: vi.fn() }));
vi.mock('@/database/models/agent', () => ({ AgentModel: vi.fn() }));
vi.mock('@/server/services/connector/oauth', async (importOriginal) => ({
  withOfflineAccessScope: (await importOriginal<Record<string, any>>()).withOfflineAccessScope,
  buildAuthorizationUrl: mocks.buildAuthorizationUrl,
  discoverConnectorOAuth: mocks.discoverConnectorOAuth,
  getConnectorClientMetadataUrl: mocks.getClientMetadataUrl,
  getConnectorRedirectUri: () => 'https://app.example.com/oauth/connector/callback',
  registerDynamicClient: mocks.registerDynamicClient,
}));
vi.mock('@/server/services/connector/stateStore', () => ({
  generateConnectorOAuthState: () => 'state-1',
  saveConnectorOAuthState: mocks.saveState,
}));

const CIMD_URL = 'https://app.example.com/oauth/connector/client-metadata';
const ID = '11111111-1111-4111-8111-111111111111';

const caller = () => connectorRouter.createCaller({ userId: 'user-1' } as any);

const discovered = (over: Record<string, unknown> = {}) => ({
  authorizationServerUrl: 'https://auth.example.com',
  metadata: {
    authorization_endpoint: 'https://auth.example.com/authorize',
    registration_endpoint: 'https://auth.example.com/register',
    scopes_supported: ['openid', 'email', 'admin'],
    token_endpoint: 'https://auth.example.com/token',
    ...over,
  },
  resourceMetadata: { resource: 'https://mcp.example.com/', scopes_supported: ['openid'] },
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.connectorFindById.mockResolvedValue({
    id: ID,
    mcpServerUrl: 'https://mcp.example.com',
    oidcConfig: { scheme: 'dcr' },
    userId: 'user-1',
  });
  mocks.getClientMetadataUrl.mockReturnValue(CIMD_URL);
  mocks.buildAuthorizationUrl.mockResolvedValue({
    authorizationUrl: 'https://auth.example.com/authorize?x=1',
    codeVerifier: 'verifier',
  });
  mocks.registerDynamicClient.mockResolvedValue({ client_id: 'dcr-client' });
});

describe('connector.startOAuth', () => {
  it('uses the client metadata document instead of DCR when the server supports it', async () => {
    mocks.discoverConnectorOAuth.mockResolvedValue(
      discovered({ client_id_metadata_document_supported: true }),
    );

    await caller().startOAuth({ id: ID });

    expect(mocks.registerDynamicClient).not.toHaveBeenCalled();
    expect(mocks.buildAuthorizationUrl.mock.calls[0][0].clientInformation.client_id).toBe(CIMD_URL);
    expect(mocks.connectorUpdate.mock.calls[0][1].oidcConfig).toMatchObject({
      clientId: CIMD_URL,
      scheme: 'client_id_metadata_document',
    });
  });

  it('falls back to DCR when no public HTTPS metadata URL is available', async () => {
    mocks.getClientMetadataUrl.mockReturnValue(undefined);
    mocks.discoverConnectorOAuth.mockResolvedValue(
      discovered({ client_id_metadata_document_supported: true }),
    );

    await caller().startOAuth({ id: ID });

    expect(mocks.registerDynamicClient).toHaveBeenCalledOnce();
    expect(mocks.connectorUpdate.mock.calls[0][1].oidcConfig.scheme).toBe('dcr');
  });

  it('keeps a user-supplied client id (pre-registration)', async () => {
    mocks.connectorFindById.mockResolvedValue({
      id: ID,
      mcpServerUrl: 'https://mcp.example.com',
      oidcConfig: { clientId: 'mine', scheme: 'pre_registration' },
      userId: 'user-1',
    });
    mocks.discoverConnectorOAuth.mockResolvedValue(
      discovered({ client_id_metadata_document_supported: true }),
    );

    await caller().startOAuth({ id: ID });

    expect(mocks.registerDynamicClient).not.toHaveBeenCalled();
    expect(mocks.buildAuthorizationUrl.mock.calls[0][0].clientInformation.client_id).toBe('mine');
  });

  it('requests the resource-metadata scopes and resource, never the full AS scope list', async () => {
    mocks.discoverConnectorOAuth.mockResolvedValue(discovered());

    await caller().startOAuth({ id: ID });

    const args = mocks.buildAuthorizationUrl.mock.calls[0][0];
    expect(args.scopes).toEqual(['openid']);
    expect(args.resource).toBe('https://mcp.example.com/');
    expect(mocks.saveState.mock.calls[0][1].resource).toBe('https://mcp.example.com/');
  });

  // Regression: Vercel lists `offline_access` only in its authorization-server
  // metadata. Without it no refresh token was issued, so tool calls hit a 401 as
  // soon as the access token expired.
  it('adds offline_access when the authorization server supports it', async () => {
    mocks.discoverConnectorOAuth.mockResolvedValue(
      discovered({ scopes_supported: ['openid', 'email', 'offline_access'] }),
    );

    await caller().startOAuth({ id: ID });

    expect(mocks.buildAuthorizationUrl.mock.calls[0][0].scopes).toEqual([
      'openid',
      'offline_access',
    ]);
  });

  it('adds offline_access on re-authorization over previously stored scopes', async () => {
    mocks.connectorFindById.mockResolvedValue({
      id: ID,
      mcpServerUrl: 'https://mcp.example.com',
      oidcConfig: { scheme: 'client_id_metadata_document', scopes: ['openid'] },
      userId: 'user-1',
    });
    mocks.discoverConnectorOAuth.mockResolvedValue(
      discovered({ scopes_supported: ['openid', 'offline_access'] }),
    );

    await caller().startOAuth({ id: ID });

    expect(mocks.buildAuthorizationUrl.mock.calls[0][0].scopes).toEqual([
      'openid',
      'offline_access',
    ]);
  });

  it('omits scope when neither the challenge nor the resource metadata names any', async () => {
    mocks.discoverConnectorOAuth.mockResolvedValue({
      ...discovered(),
      resourceMetadata: undefined,
    });

    await caller().startOAuth({ id: ID });

    expect(mocks.buildAuthorizationUrl.mock.calls[0][0].scopes).toBeUndefined();
  });

  it('turns an authorization-server rejection into a BAD_REQUEST carrying its reason', async () => {
    mocks.discoverConnectorOAuth.mockResolvedValue(discovered());
    mocks.registerDynamicClient.mockRejectedValue(
      new ServerError('The provided redirect URIs are not approved'),
    );

    await expect(caller().startOAuth({ id: ID })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('The provided redirect URIs are not approved'),
    });
  });
});
