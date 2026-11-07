// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ensureFreshConnectorToken } from './tokens';

const mocks = vi.hoisted(() => ({
  discover: vi.fn(),
  fetchFn: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock('@modelcontextprotocol/sdk/client/auth.js', () => ({
  discoverAuthorizationServerMetadata: mocks.discover,
}));
vi.mock('@/libs/mcp/serverFetch', () => ({ getMcpServerFetch: () => mocks.fetchFn }));
vi.mock('./oauth', () => ({ refreshConnectorToken: mocks.refresh }));

const connector = (expiresAt?: number) =>
  ({
    credentials: { accessToken: 'old', expiresAt, refreshToken: 'r', type: 'oauth2' },
    id: 'c1',
    mcpServerUrl: 'https://mcp.example.com',
    oidcConfig: { clientId: 'cid', issuer: 'https://auth.example.com', scheme: 'dcr' },
  }) as any;

const model = { update: vi.fn() } as any;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.discover.mockResolvedValue({ token_endpoint: 'https://auth.example.com/token' });
  mocks.refresh.mockResolvedValue({ access_token: 'new', expires_in: 3600 });
});

describe('ensureFreshConnectorToken', () => {
  it('does not refresh a token that has no known expiry', async () => {
    await ensureFreshConnectorToken(connector(undefined), model);

    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it('refreshes an expired token, fetching metadata through the SSRF-safe fetch', async () => {
    const fresh = await ensureFreshConnectorToken(connector(Date.now() - 1000), model);

    expect(mocks.discover).toHaveBeenCalledWith('https://auth.example.com', {
      fetchFn: mocks.fetchFn,
    });
    expect(mocks.refresh).toHaveBeenCalledOnce();
    expect((fresh.credentials as any).accessToken).toBe('new');
  });

  it('refreshes a token the stored expiry still calls valid when forced', async () => {
    const fresh = await ensureFreshConnectorToken(connector(Date.now() + 3_600_000), model, {
      force: true,
    });

    expect(mocks.refresh).toHaveBeenCalledOnce();
    expect((fresh.credentials as any).accessToken).toBe('new');
  });

  it('refreshes a token with no known expiry when forced', async () => {
    await ensureFreshConnectorToken(connector(undefined), model, { force: true });

    expect(mocks.refresh).toHaveBeenCalledOnce();
  });

  it('logs a failed refresh and keeps the old token', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.refresh.mockRejectedValue(new Error('invalid_grant'));

    const result = await ensureFreshConnectorToken(connector(Date.now() - 1000), model);

    expect((result.credentials as any).accessToken).toBe('old');
    expect(warn).toHaveBeenCalledWith(expect.any(String), 'c1', 'invalid_grant');
    warn.mockRestore();
  });
});
