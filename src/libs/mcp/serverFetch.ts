import { isDesktop } from '@lobechat/const';
import { ssrfSafeFetch } from '@lobechat/ssrf-safe-fetch';
import { type FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';

/**
 * Fetch for every server-side request to a user-supplied MCP endpoint (transport, OAuth
 * discovery, registration and token calls).
 *
 * On the web server it is `ssrfSafeFetch`, which checks the address actually connected to
 * on every redirect hop, so a public hostname that resolves to a private or metadata
 * address is refused too. `SSRF_ALLOW_PRIVATE_IP_ADDRESS` / `SSRF_ALLOW_IP_ADDRESS_LIST`
 * still opt self-hosted LAN servers in. Desktop talks to the user's own machine, so it
 * keeps the platform fetch (`undefined` lets the SDK use it).
 */
export const getMcpServerFetch = (): FetchLike | undefined =>
  isDesktop ? undefined : (url, init) => ssrfSafeFetch(url.toString(), init);
