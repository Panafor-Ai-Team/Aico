import type * as BusinessConst from '@lobechat/business-const';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '../../../core/getTestDB';
import { OpenRouterModelCatalogModel } from '../../../models/openrouterModelCatalog';
import { openrouterModelCatalog } from '../../../schemas';
import type { LobeChatDatabase } from '../../../type';

// The production configuration: `BRANDING_PROVIDER` is never set, so it keeps
// its `official` fallback, while CheapVibeCode is the live gateway. Every stored
// agent config, and the site's "enable models" modal, still use `openrouter`.
vi.mock('@lobechat/business-const', async (importOriginal) => ({
  ...(await importOriginal<typeof BusinessConst>()),
  BRANDING_PROVIDER: 'official',
  MANAGED_PROVIDER_ID: 'cheapvibecode',
}));

vi.mock('@lobechat/model-runtime', () => ({
  fetchOpenRouterModels: vi.fn().mockRejectedValue(new Error('must not bootstrap')),
}));

vi.mock('@lobechat/business-model-bank/model-config', async () => {
  const { LOBE_DEFAULT_MODEL_LIST } = await import('model-bank');
  return { loadModels: vi.fn().mockResolvedValue(LOBE_DEFAULT_MODEL_LIST) };
});

let db: LobeChatDatabase;

const seedCatalog = async () => {
  await new OpenRouterModelCatalogModel(db).replaceCatalog({
    models: [{ id: 'claude-fable-5', type: 'chat' } as any],
    triggeredBy: 'test',
  });
};

const createRepo = async () => {
  const { __resetUsageMultiplierCache, AiInfraRepos } = await import('../index');
  __resetUsageMultiplierCache();
  const repo = new AiInfraRepos(db, 'test-user-id', { openrouter: { enabled: true } });
  vi.spyOn(repo as any, 'resolveUsageMultiplierBp').mockResolvedValue(12_500);
  vi.spyOn(repo as any, 'resolveModelMultiplierOverrides').mockResolvedValue({});
  return repo;
};

beforeEach(async () => {
  db = await getTestDB();
  await db.delete(openrouterModelCatalog);
  vi.restoreAllMocks();
}, 30_000);

describe('the openrouter slot when BRANDING_PROVIDER is not configured', () => {
  it('serves the admin-managed catalog, not the static OpenRouter list', async () => {
    await seedCatalog();
    const repo = await createRepo();

    const models = (await (repo as any).fetchBuiltinModels('openrouter')) as { id: string }[];
    const ids = new Set(models.map((m) => m.id));

    expect(ids.has('claude-fable-5')).toBe(true);
    expect(ids.has('openai/gpt-4o')).toBe(false);
  });

  it('drops a user override for a model the managed catalog does not carry', async () => {
    await seedCatalog();
    const repo = await createRepo();
    // Left behind by toggling the static OpenRouter list: the live gateway has
    // no such model, so offering it would only produce failed requests.
    vi.spyOn(repo.aiModelModel, 'getModelListByProviderId').mockResolvedValue([
      { enabled: true, id: 'deepseek/deepseek-r1', providerId: 'openrouter', type: 'chat' } as any,
    ]);

    const ids = new Set((await repo.getAiProviderModelList('openrouter')).map((m) => m.id));

    expect(ids.has('claude-fable-5')).toBe(true);
    expect(ids.has('deepseek/deepseek-r1')).toBe(false);
  });
});
