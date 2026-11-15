import { afterEach, describe, expect, it, vi } from 'vitest';

import { getMarketBaseUrl } from './baseUrl';

const setInjected = (marketBaseUrl?: string) => {
  window.__SERVER_CONFIG__ =
    marketBaseUrl === undefined
      ? undefined
      : ({ clientEnv: { marketBaseUrl } } as unknown as typeof window.__SERVER_CONFIG__);
};

describe('getMarketBaseUrl', () => {
  afterEach(() => {
    setInjected();
    vi.unstubAllEnvs();
  });

  it('prefers the URL the server injects, so a self-hosted Market needs no rebuild', () => {
    setInjected('https://market.example.com');
    vi.stubEnv('NEXT_PUBLIC_MARKET_BASE_URL', 'https://baked.example.com');

    expect(getMarketBaseUrl()).toBe('https://market.example.com');
  });

  it('falls back to the build-time URL, then upstream', () => {
    vi.stubEnv('NEXT_PUBLIC_MARKET_BASE_URL', 'https://baked.example.com');
    expect(getMarketBaseUrl()).toBe('https://baked.example.com');

    vi.stubEnv('NEXT_PUBLIC_MARKET_BASE_URL', '');
    expect(getMarketBaseUrl()).toBe('https://market.lobehub.com');
  });
});
