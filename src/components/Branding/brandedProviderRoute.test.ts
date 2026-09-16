import { describe, expect, it, vi } from 'vitest';

vi.mock('@/const/version', () => ({ isCustomBranding: true }));
vi.mock('@lobechat/business-const', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  BRANDING_NAME: 'Panachat',
  BRANDING_PROVIDER: 'openrouter',
}));

const load = () => import('./brandedProviderRoute');

describe('branded provider URL segment', () => {
  it('shows the product slug instead of the storage id', async () => {
    const { toProviderRouteSegment } = await load();
    // `openrouter` is a storage detail — it is the id inside every saved agent
    // config — and says the wrong thing to a user whose traffic goes elsewhere.
    expect(toProviderRouteSegment('openrouter')).toBe('panachat');
  });

  it("leaves every other provider's URL alone", async () => {
    const { toProviderRouteSegment } = await load();
    expect(toProviderRouteSegment('openai')).toBe('openai');
    expect(toProviderRouteSegment('anthropic')).toBe('anthropic');
  });

  it('still resolves links minted before the pretty URL existed', async () => {
    const { fromProviderRouteSegment } = await load();
    for (const segment of ['panachat', 'Panachat', ' aico ', 'openrouter']) {
      expect(fromProviderRouteSegment(segment)).toBe('openrouter');
    }
  });

  it('does not claim an unrelated provider is the branded slot', async () => {
    const { fromProviderRouteSegment, isBrandedProviderRouteSegment } = await load();
    expect(fromProviderRouteSegment('openai')).toBe('openai');
    expect(isBrandedProviderRouteSegment('openai')).toBe(false);
    expect(isBrandedProviderRouteSegment(null)).toBe(false);
  });
});
