// @vitest-environment node
import { createServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { MCPClient } from '../client';
import { getMcpServerFetch } from '../serverFetch';

const platform = vi.hoisted(() => ({ isDesktop: false }));
vi.mock('@lobechat/const', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  get isDesktop() {
    return platform.isDesktop;
  },
}));

/**
 * `localhost` resolves to 127.0.0.1 but is only a name: these tests prove the refusal
 * happens at connect time, not by matching the URL text.
 */
let server: Server;
let requests: string[] = [];
let url: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.writeHead(500).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://localhost:${(server.address() as AddressInfo).port}/mcp`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

afterEach(() => {
  requests = [];
  platform.isDesktop = false;
  vi.unstubAllEnvs();
});

const errorChain = (error: unknown): string => {
  const messages: string[] = [];
  for (let current: any = error; current; current = current.cause) messages.push(current.message);
  return messages.join(' <- ');
};

describe('getMcpServerFetch', () => {
  it('leaves Desktop on the platform fetch', () => {
    platform.isDesktop = true;
    expect(getMcpServerFetch()).toBeUndefined();
  });

  it('refuses a hostname that resolves to a private address on the web server', async () => {
    vi.stubEnv('SSRF_ALLOW_PRIVATE_IP_ADDRESS', '');
    const error = await getMcpServerFetch()!(url, { method: 'POST' }).catch((e) => e);

    expect(errorChain(error)).toContain('SSRF blocked');
    expect(requests).toEqual([]);
  });

  it('lets self-hosters opt in to private MCP servers', async () => {
    vi.stubEnv('SSRF_ALLOW_PRIVATE_IP_ADDRESS', '1');
    const response = await getMcpServerFetch()!(url, { method: 'POST' });

    expect(response.status).toBe(500);
    expect(requests).toEqual(['POST /mcp']);
  });
});

describe('MCPClient HTTP transport', () => {
  it('connects through the SSRF-safe fetch on the web server', async () => {
    vi.stubEnv('SSRF_ALLOW_PRIVATE_IP_ADDRESS', '');
    const client = new MCPClient({ name: 'stub', type: 'http', url });

    const error = await client.initialize().catch((e) => e);

    expect(errorChain(error)).toContain('SSRF blocked');
    expect(requests).toEqual([]);
  });

  it('reaches an opted-in private server', async () => {
    vi.stubEnv('SSRF_ALLOW_PRIVATE_IP_ADDRESS', '1');
    const client = new MCPClient({ name: 'stub', type: 'http', url });

    await client.initialize().catch(() => {});

    expect(requests).toContain('POST /mcp');
  });
});
