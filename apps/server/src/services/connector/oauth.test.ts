// @vitest-environment node
import { createServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { discoverConnectorOAuth } from './oauth';

/**
 * OAuth discovery fetches the user's MCP URL and the metadata URLs it advertises. On the
 * web server those requests must refuse private addresses even behind a public-looking
 * name (`localhost` here, which resolves to 127.0.0.1 without matching any URL check).
 */
let server: Server;
let requests: string[] = [];
let origin: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (req.url === '/.well-known/oauth-authorization-server') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          authorization_endpoint: `${origin}/authorize`,
          issuer: origin,
          response_types_supported: ['code'],
          token_endpoint: `${origin}/token`,
        }),
      );
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://localhost:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

afterEach(() => {
  requests = [];
  vi.unstubAllEnvs();
});

describe('discoverConnectorOAuth', () => {
  it('sends nothing to a private address on the web server', async () => {
    vi.stubEnv('SSRF_ALLOW_PRIVATE_IP_ADDRESS', '');

    await expect(discoverConnectorOAuth(`${origin}/mcp`)).rejects.toThrow();
    expect(requests).toEqual([]);
  });

  it('discovers an opted-in private server', async () => {
    vi.stubEnv('SSRF_ALLOW_PRIVATE_IP_ADDRESS', '1');

    const discovered = await discoverConnectorOAuth(`${origin}/mcp`);

    expect(discovered.authorizationServerUrl).toBe(origin);
    expect(discovered.metadata.token_endpoint).toBe(`${origin}/token`);
    expect(requests).toContain('GET /mcp');
  });
});
