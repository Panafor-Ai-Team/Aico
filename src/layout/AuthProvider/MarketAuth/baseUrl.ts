const UPSTREAM_MARKET_BASE_URL = 'https://market.lobehub.com';

/**
 * Market base URL, in deployment precedence:
 *
 * 1. `MARKET_BASE_URL` — the server injects it into the SPA shell, so pointing
 *    at a self-hosted Market is a deploy-env change, not an image rebuild.
 * 2. `NEXT_PUBLIC_MARKET_BASE_URL` — baked into clients that never load the
 *    shell (desktop dev builds).
 * 3. Upstream LobeHub Market — deployments that don't host one keep working.
 */
export const getMarketBaseUrl = (): string => {
  const injected =
    typeof window === 'undefined' ? undefined : window.__SERVER_CONFIG__?.clientEnv?.marketBaseUrl;

  return injected || process.env.NEXT_PUBLIC_MARKET_BASE_URL || UPSTREAM_MARKET_BASE_URL;
};
