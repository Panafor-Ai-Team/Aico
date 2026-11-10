import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '../../../core/getTestDB';
import { OpenRouterModelCatalogModel } from '../../../models/openrouterModelCatalog';
import { openrouterModelCatalog, platformModelMultiplierOverrides } from '../../../schemas';
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

const rate = (models: { id: string; pricing?: { units?: any[] } }[], id: string) =>
  (models.find((m) => m.id === id)?.pricing?.units?.[0] as { rate: number } | undefined)?.rate;

beforeEach(async () => {
  db = await getTestDB();
  await db.delete(openrouterModelCatalog);
  vi.restoreAllMocks();
  __resetUsageMultiplierCache();
  repo = new AiInfraRepos(db, 'test-user-id', { openrouter: { enabled: true } });
}, 30_000);

describe('π yield — raw catalog prices on the model serve path', () => {
  it('serves catalog prices without platform markup (margin is at top-up)', async () => {
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

    expect(rate(models, 'openai/gpt-test')).toBeCloseTo(3, 10);
    expect(models.find((m) => m.id === 'openai/gpt-test')).not.toHaveProperty('pricing.prompt');
  });

  it('serves the static model-bank fallback at raw rates too', async () => {
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

    expect(rate(models, 'fallback/model')).toBeCloseTo(2, 10);
  });
});

describe('per-model coefficients on the serve path', () => {
  const MODEL_ID = 'test/override-ignored-model';

  beforeEach(async () => {
    await db
      .delete(platformModelMultiplierOverrides)
      .where(eq(platformModelMultiplierOverrides.modelId, MODEL_ID));
  });

  it('ignores a stored admin override: catalog coefficient alone is served', async () => {
    await db.insert(platformModelMultiplierOverrides).values({
      modelId: MODEL_ID,
      multiplierBp: 40_000,
      providerId: 'openrouter',
    });
    await new OpenRouterModelCatalogModel(db).replaceCatalog({
      models: [
        {
          id: MODEL_ID,
          pricing: {
            units: [{ name: 'textInput', rate: 0.16, strategy: 'fixed', unit: 'millionTokens' }],
          },
          type: 'chat',
        } as any,
      ],
      triggeredBy: 'test',
    });

    const models = (await (repo as any).fetchBuiltinModels('openrouter')) as any[];

    expect(rate(models, MODEL_ID)).toBeCloseTo(0.16, 10);
  });
});
