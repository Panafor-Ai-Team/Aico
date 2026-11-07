import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ConnectorToolPermission } from '@/database/schemas';
import { deviceGateway } from '@/server/services/deviceGateway';
import { mcpService } from '@/server/services/mcp';

import { callConnectorToolById } from './exec';
import { scheduleStaleConnectorToolsRefresh } from './refresh';
import { ensureFreshConnectorToken } from './tokens';

vi.mock('@/server/services/mcp', () => ({ mcpService: { callTool: vi.fn() } }));
vi.mock('@/server/services/deviceGateway', () => ({ deviceGateway: { isConfigured: false } }));
vi.mock('./tokens', () => ({ ensureFreshConnectorToken: vi.fn(async (c) => c) }));
// The background tool-list refresh is exercised in refresh.test.ts. Here we only
// verify the call site wires it up and stays isolated from it.
vi.mock('./refresh', () => ({
  buildLastSyncedAtMap: vi.fn(() => new Map()),
  scheduleStaleConnectorToolsRefresh: vi.fn(),
}));

const connector = {
  credentials: { accessToken: 'tok', type: 'oauth2' },
  id: 'c1',
  identifier: 'my-conn',
  isEnabled: true,
  mcpConnectionType: 'http',
  mcpServerUrl: 'https://mcp.example.com',
  mcpStdioConfig: null,
  name: 'My Connector',
  oidcConfig: null,
} as any;

const tool = (over: Record<string, unknown> = {}) => ({
  permission: ConnectorToolPermission.auto,
  toolName: 'do_thing',
  ...over,
});

const makeCtx = (connectors: any[], tools: any[]) =>
  ({
    connectorModel: {
      queryByIdentifiers: vi.fn().mockResolvedValue(connectors),
      updateStatus: vi.fn(),
    },
    connectorToolModel: { queryByConnector: vi.fn().mockResolvedValue(tools) },
  }) as any;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(ensureFreshConnectorToken).mockImplementation(async (c: any) => c);
  (deviceGateway as any).isConfigured = false;
});

describe('callConnectorToolById', () => {
  it('rejects when the connector is not found', async () => {
    await expect(
      callConnectorToolById({ identifier: 'x', toolName: 'do_thing' }, makeCtx([], [])),
    ).rejects.toHaveProperty('code', 'NOT_FOUND');
  });

  it('rejects when the connector is disabled', async () => {
    const ctx = makeCtx([{ ...connector, isEnabled: false }], [tool()]);
    await expect(
      callConnectorToolById({ identifier: 'my-conn', toolName: 'do_thing' }, ctx),
    ).rejects.toHaveProperty('code', 'FORBIDDEN');
    expect(mcpService.callTool).not.toHaveBeenCalled();
  });

  it('rejects an unknown tool name not in the synced list', async () => {
    const ctx = makeCtx([connector], [tool({ toolName: 'other' })]);
    await expect(
      callConnectorToolById({ identifier: 'my-conn', toolName: 'do_thing' }, ctx),
    ).rejects.toHaveProperty('code', 'BAD_REQUEST');
    expect(mcpService.callTool).not.toHaveBeenCalled();
  });

  it('rejects a disabled tool', async () => {
    const ctx = makeCtx([connector], [tool({ permission: ConnectorToolPermission.disabled })]);
    await expect(
      callConnectorToolById({ identifier: 'my-conn', toolName: 'do_thing' }, ctx),
    ).rejects.toHaveProperty('code', 'FORBIDDEN');
    expect(mcpService.callTool).not.toHaveBeenCalled();
  });

  it('calls the remote MCP with the connector auth for an allowed tool', async () => {
    vi.mocked(mcpService.callTool).mockResolvedValue({ success: true });
    const ctx = makeCtx([connector], [tool()]);

    const res = await callConnectorToolById(
      { args: '{"a":1}', identifier: 'my-conn', toolName: 'do_thing' },
      ctx,
    );

    expect(res).toEqual({ success: true });
    expect(mcpService.callTool).toHaveBeenCalledWith(
      expect.objectContaining({
        argsStr: '{"a":1}',
        clientParams: expect.objectContaining({
          auth: expect.objectContaining({ accessToken: 'tok', type: 'oauth2' }),
          type: 'http',
          url: 'https://mcp.example.com',
        }),
        toolName: 'do_thing',
      }),
    );
  });

  it('uses the refreshed token when the connector token was refreshed', async () => {
    vi.mocked(ensureFreshConnectorToken).mockResolvedValueOnce({
      ...connector,
      credentials: { accessToken: 'refreshed', type: 'oauth2' },
    } as any);
    vi.mocked(mcpService.callTool).mockResolvedValue({ ok: true });
    const ctx = makeCtx([connector], [tool()]);

    await callConnectorToolById({ identifier: 'my-conn', toolName: 'do_thing' }, ctx);

    expect(mcpService.callTool).toHaveBeenCalledWith(
      expect.objectContaining({
        clientParams: expect.objectContaining({
          auth: expect.objectContaining({ accessToken: 'refreshed' }),
        }),
      }),
    );
  });

  it('schedules a background tool-list refresh for the connector', async () => {
    vi.mocked(mcpService.callTool).mockResolvedValue({ success: true });
    const ctx = makeCtx([connector], [tool()]);

    await callConnectorToolById({ identifier: 'my-conn', toolName: 'do_thing' }, ctx);

    expect(scheduleStaleConnectorToolsRefresh).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          id: 'c1',
          mcpConnectionType: 'http',
          mcpServerUrl: 'https://mcp.example.com',
        }),
      ],
      expect.anything(),
      ctx,
    );
  });

  // On a cloud deployment (device gateway configured) the server can never
  // reach a stdio binary or a localhost/LAN endpoint — those calls must fail
  // fast with an actionable message instead of a cryptic spawn/fetch error
  // (#16533). Self-hosted servers (no gateway) may share a LAN with the
  // endpoint, so the guard must NOT fire there.
  describe('device-only endpoints on a cloud deployment', () => {
    it('rejects a stdio connector when the device gateway is configured', async () => {
      (deviceGateway as any).isConfigured = true;
      const stdioConnector = {
        ...connector,
        mcpConnectionType: 'stdio',
        mcpServerUrl: null,
        mcpStdioConfig: { args: [], command: 'npx' },
      };
      const ctx = makeCtx([stdioConnector], [tool()]);

      await expect(
        callConnectorToolById({ identifier: 'my-conn', toolName: 'do_thing' }, ctx),
      ).rejects.toHaveProperty('code', 'BAD_REQUEST');
      expect(mcpService.callTool).not.toHaveBeenCalled();
    });

    it('rejects a local/private-network HTTP connector when the device gateway is configured', async () => {
      (deviceGateway as any).isConfigured = true;
      const localConnector = { ...connector, mcpServerUrl: 'http://192.168.1.10:8080/mcp' };
      const ctx = makeCtx([localConnector], [tool()]);

      await expect(
        callConnectorToolById({ identifier: 'my-conn', toolName: 'do_thing' }, ctx),
      ).rejects.toHaveProperty('code', 'BAD_REQUEST');
      expect(mcpService.callTool).not.toHaveBeenCalled();
    });

    it('still calls a local endpoint when no device gateway is configured (self-host)', async () => {
      vi.mocked(mcpService.callTool).mockResolvedValue({ success: true });
      const localConnector = { ...connector, mcpServerUrl: 'http://192.168.1.10:8080/mcp' };
      const ctx = makeCtx([localConnector], [tool()]);

      const res = await callConnectorToolById({ identifier: 'my-conn', toolName: 'do_thing' }, ctx);

      expect(res).toEqual({ success: true });
      expect(mcpService.callTool).toHaveBeenCalledTimes(1);
    });

    it('keeps calling public endpoints when the device gateway is configured', async () => {
      (deviceGateway as any).isConfigured = true;
      vi.mocked(mcpService.callTool).mockResolvedValue({ success: true });
      const ctx = makeCtx([connector], [tool()]);

      const res = await callConnectorToolById({ identifier: 'my-conn', toolName: 'do_thing' }, ctx);

      expect(res).toEqual({ success: true });
    });
  });

  it('still returns the tool result when the background refresh scheduler throws', async () => {
    // The refresh is a pure optimization; a failure in it must never break the
    // tool call the user actually asked for.
    vi.mocked(scheduleStaleConnectorToolsRefresh).mockImplementationOnce(() => {
      throw new Error('scheduler exploded');
    });
    vi.mocked(mcpService.callTool).mockResolvedValue({ success: true });
    const ctx = makeCtx([connector], [tool()]);

    const res = await callConnectorToolById({ identifier: 'my-conn', toolName: 'do_thing' }, ctx);

    expect(res).toEqual({ success: true });
    expect(mcpService.callTool).toHaveBeenCalledTimes(1);
  });
});

// Regression: Vercel answered 401 once the access token expired, and the call
// failed as an opaque 500 the chat showed as "no result returned".
describe('callConnectorToolById — upstream 401', () => {
  const authRequired = () =>
    Object.assign(new Error('MCP_AUTH_REQUIRED'), { code: 'PRECONDITION_FAILED' });
  const oauthConnector = {
    ...connector,
    credentials: { accessToken: 'old', refreshToken: 'r', type: 'oauth2' },
  };

  it('forces a token refresh and retries once', async () => {
    const refreshed = {
      ...oauthConnector,
      credentials: { ...oauthConnector.credentials, accessToken: 'new' },
    };
    vi.mocked(ensureFreshConnectorToken).mockImplementation(async (c: any, _m: any, opts?: any) =>
      opts?.force ? refreshed : c,
    );
    vi.mocked(mcpService.callTool)
      .mockRejectedValueOnce(authRequired())
      .mockResolvedValueOnce({ content: 'ok', success: true } as any);
    const ctx = makeCtx([oauthConnector], [tool()]);

    const result = await callConnectorToolById(
      { identifier: 'my-conn', toolName: 'do_thing' },
      ctx,
    );

    expect(result).toEqual({ content: 'ok', success: true });
    expect(vi.mocked(ensureFreshConnectorToken).mock.calls[1][2]).toEqual({ force: true });
    expect(vi.mocked(mcpService.callTool).mock.calls[1][0].clientParams).toMatchObject({
      auth: { accessToken: 'new' },
    });
    expect(ctx.connectorModel.updateStatus).not.toHaveBeenCalled();
  });

  it('marks the connector as errored and asks to reconnect when refresh cannot help', async () => {
    vi.mocked(mcpService.callTool).mockRejectedValue(authRequired());
    const ctx = makeCtx([oauthConnector], [tool()]);

    const error = await callConnectorToolById(
      { identifier: 'my-conn', toolName: 'do_thing' },
      ctx,
    ).catch((e: any) => e);

    expect(error).toHaveProperty('code', 'PRECONDITION_FAILED');
    expect(error.message).toContain('reconnect');
    expect(ctx.connectorModel.updateStatus).toHaveBeenCalledWith('c1', 'error');
    expect(mcpService.callTool).toHaveBeenCalledTimes(1);
  });

  it('rethrows other errors unchanged', async () => {
    vi.mocked(mcpService.callTool).mockRejectedValue(new Error('boom'));
    const ctx = makeCtx([oauthConnector], [tool()]);

    await expect(
      callConnectorToolById({ identifier: 'my-conn', toolName: 'do_thing' }, ctx),
    ).rejects.toThrow('boom');
    expect(ctx.connectorModel.updateStatus).not.toHaveBeenCalled();
  });
});
