import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '../../../core/getTestDB';
import { OpenRouterModelCatalogModel } from '../../../models/openrouterModelCatalog';
import { openrouterModelCatalog } from '../../../schemas';
import type { LobeChatDatabase } from '../../../type';
import { __resetUsageMultiplierCache, AiInfraRepos } from '../index';

// Keep the bootstrap sync off the network: this suite is about the serve path.
vi.mock('@lobechat/model-runtime', () => ({
  fetchOpenRouterModels: vi.fn().mockRejectedValue(new Error('offline')),
}));

vi.mock('@lobechat/business-model-bank/model-config', async () => {
  const { LOBE_DEFAULT_MODEL_LIST } = await import('model-bank');
  return { loadModels: vi.fn().mockResolvedValue(LOBE_DEFAULT_MODEL_LIST) };
});

let db: LobeChatDatabase;
let repo: AiInfraRepos;

/**
 * Stub the multiplier rather than writing the platform config row: that row is
 * global, and other suites sharing this database read it concurrently.
 */
const setMultiplier = (bp: number) => {
  __resetUsageMultiplierCache();
  vi.spyOn(repo as any, 'resolveUsageMultiplierBp').mockResolvedValue(bp);
};

const rate = (models: { id: string; pricing?: { units?: any[] } }[], id: string) =>
  (models.find((m) => m.id === id)?.pricing?.units?.[0] as { rate: number } | undefined)?.rate;

beforeEach(async () => {
  db = await getTestDB();
  await db.delete(openrouterModelCatalog);
  vi.restoreAllMocks();
  __resetUsageMultiplierCache();
  repo = new AiInfraRepos(db, 'test-user-id', { openrouter: { enabled: true } });
}, 30_000);

describe('AICO-180 usage multiplier on the model serve path', () => {
  it('marks catalog prices up and never leaks the raw payload price', async () => {
    setMultiplier(12_000);
    await new OpenRouterModelCatalogModel(db).replaceCatalog({
      models: [
        {
          id: 'openai/gpt-test',
          payload: {
            // The raw OpenRouter JSON carries its own pricing shape — it must not
            // survive the spread into a client-visible response.
            pricing: { completion: '0.00002', prompt: '0.00001' },
          },
          pricing: {
            units: [{ name: 'textInput', rate: 3, strategy: 'fixed', unit: 'millionTokens' }],
          },
          type: 'chat',
        } as any,
      ],
      triggeredBy: 'test',
    });

    const models = (await (repo as any).fetchBuiltinModels('openrouter')) as any[];

    expect(rate(models, 'openai/gpt-test')).toBeCloseTo(3.6, 10);
    expect(models.find((m) => m.id === 'openai/gpt-test')).not.toHaveProperty('pricing.prompt');
  });

  it('marks the static model-bank fallback up too, so an empty catalog is not a bypass', async () => {
    setMultiplier(15_000);
    // Bootstrap sync is unavailable in tests, so this exercises the fallback.
    vi.spyOn(repo as any, 'getModelBankModels').mockResolvedValue([
      {
        id: 'fallback/model',
        pricing: {
          units: [{ name: 'textInput', rate: 2, strategy: 'fixed', unit: 'millionTokens' }],
        },
        providerId: 'openrouter',
        type: 'chat',
      },
    ]);

    const models = (await (repo as any).fetchBuiltinModels('openrouter')) as any[];

    expect(rate(models, 'fallback/model')).toBeCloseTo(3, 10);
  });

  it('applies a multiplier change to the next request without a re-sync', async () => {
    setMultiplier(12_000);
    await new OpenRouterModelCatalogModel(db).replaceCatalog({
      models: [
        {
          id: 'openai/gpt-test',
          pricing: {
            units: [{ name: 'textInput', rate: 3, strategy: 'fixed', unit: 'millionTokens' }],
          },
          type: 'chat',
        } as any,
      ],
      triggeredBy: 'test',
    });

    expect(
      rate(await (repo as any).fetchBuiltinModels('openrouter'), 'openai/gpt-test'),
    ).toBeCloseTo(3.6, 10);

    setMultiplier(20_000);

    expect(
      rate(await (repo as any).fetchBuiltinModels('openrouter'), 'openai/gpt-test'),
    ).toBeCloseTo(6, 10);
  });
});
