import type * as BusinessConst from '@lobechat/business-const';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '../../../core/getTestDB';
import { OpenRouterModelCatalogModel } from '../../../models/openrouterModelCatalog';
import { openrouterModelCatalog } from '../../../schemas';
import type { LobeChatDatabase } from '../../../type';

// The branded slot and the live gateway are deliberately different ids under
// CheapVibeCode: the slot stays `openrouter` so stored agent configs keep
// resolving, while `AICO_MANAGED_PROVIDER` says who actually serves the traffic.
vi.mock('@lobechat/business-const', async (importOriginal) => ({
  ...(await importOriginal<typeof BusinessConst>()),
  BRANDING_PROVIDER: 'openrouter',
  MANAGED_PROVIDER_ID: 'cheapvibecode',
}));

// The bootstrap path must never be reached for a non-OpenRouter gateway; if it
// is, this rejection surfaces as a static fallback instead of the catalog.
vi.mock('@lobechat/model-runtime', () => ({
  fetchOpenRouterModels: vi.fn().mockRejectedValue(new Error('must not bootstrap')),
}));

vi.mock('@lobechat/business-model-bank/model-config', async () => {
  const { LOBE_DEFAULT_MODEL_LIST } = await import('model-bank');
  return { loadModels: vi.fn().mockResolvedValue(LOBE_DEFAULT_MODEL_LIST) };
});

let db: LobeChatDatabase;

beforeEach(async () => {
  db = await getTestDB();
  await db.delete(openrouterModelCatalog);
  vi.restoreAllMocks();
}, 30_000);

describe('the branded provider slot while another gateway is live', () => {
  it('serves the synced catalog, not the slot name’s static model bank', async () => {
    const { __resetUsageMultiplierCache, AiInfraRepos } = await import('../index');
    __resetUsageMultiplierCache();

    await new OpenRouterModelCatalogModel(db).replaceCatalog({
      // A CheapVibeCode-shaped row: bare id, no vendor prefix.
      models: [{ id: 'glm-5.3-flash', type: 'chat' } as any],
      triggeredBy: 'test',
    });

    const repo = new AiInfraRepos(db, 'test-user-id', { openrouter: { enabled: true } });
    vi.spyOn(repo as any, 'resolveUsageMultiplierBp').mockResolvedValue(12_500);

    const models = (await (repo as any).fetchBuiltinModels('openrouter')) as { id: string }[];
    const ids = new Set(models.map((m) => m.id));

    // Keying this on the gateway id alone made the branded page fall through to
    // the static OpenRouter snapshot — users saw GPT-4o and Claude Opus 4.5 at
    // OpenRouter prices while every request went to CheapVibeCode.
    expect(ids.has('glm-5.3-flash')).toBe(true);
    expect(ids.has('openai/gpt-4o')).toBe(false);
  });
});
