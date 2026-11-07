// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { MCPClient } from './client';

const mocks = vi.hoisted(() => ({ connect: vi.fn() }));

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn().mockImplementation(() => ({ connect: mocks.connect })),
}));

describe('MCPClient.initialize', () => {
  it('reports an upstream 401 (status only on .code) as AUTHORIZATION_ERROR', async () => {
    mocks.connect.mockRejectedValue(
      Object.assign(
        new Error('Streamable HTTP error: Error POSTing to endpoint: {"error":"invalid_token"}'),
        { code: 401 },
      ),
    );
    const client = new MCPClient({ name: 'x', type: 'http', url: 'https://mcp.example.com' });

    await expect(client.initialize()).rejects.toMatchObject({
      data: { type: 'AUTHORIZATION_ERROR' },
    });
  });
});
