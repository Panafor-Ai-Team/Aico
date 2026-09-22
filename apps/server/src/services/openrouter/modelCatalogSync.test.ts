import type { ChatModelCard } from '@lobechat/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { OpenRouterModelCatalogModel } from '@/database/models/openrouterModelCatalog';
import { openrouterModelCatalog, openrouterModelSyncState } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';

const fetchOpenRouterModels = vi.fn();

vi.mock('@lobechat/model-runtime', () => ({
  fetchOpenRouterModels: (...args: unknown[]) => fetchOpenRouterModels(...args),
}));

describe('OpenRouterModelCatalogSyncService', () => {
  let db: LobeChatDatabase;

  beforeEach(async () => {
    db = await getTestDB();
    await db.delete(openrouterModelCatalog);
    await db.delete(openrouterModelSyncState);
    fetchOpenRouterModels.mockReset();
  }, 30_000);

  it('writes catalog rows on successful fetch', async () => {
    fetchOpenRouterModels.mockResolvedValue([
      {
        displayName: 'GPT-4o',
        functionCall: true,
        id: 'openai/gpt-4o',
        maxOutput: 16_384,
        releasedAt: '2025-01-01',
        type: 'chat',
        vision: true,
      },
      {
        displayName: 'Auto',
        functionCall: true,
        id: 'openrouter/auto',
        type: 'chat',
        vision: true,
      },
      {
        displayName: 'Nano Banana 2',
        id: 'google/gemini-3.1-flash-image-preview:image',
        parameters: { prompt: { default: '' } },
        type: 'image',
      },
    ]);

    const { OpenRouterModelCatalogSyncService } = await import('./modelCatalogSync');
    const service = new OpenRouterModelCatalogSyncService(db);
    const status = await service.sync('manual:admin-1');

    expect(status).toMatchObject({
      lastStatus: 'success',
      lastTriggeredBy: 'manual:admin-1',
      // Fetched models + injected default embedding card
      modelCount: 4,
    });

    const catalog = new OpenRouterModelCatalogModel(db);
    const models = await catalog.listAsProviderModels();
    expect(models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          abilities: expect.objectContaining({ functionCall: true, vision: true }),
          displayName: 'GPT-4o',
          enabled: true,
          id: 'openai/gpt-4o',
          type: 'chat',
        }),
        expect.objectContaining({
          abilities: expect.objectContaining({ functionCall: true, vision: true }),
          enabled: true,
          id: 'openrouter/auto',
          type: 'chat',
        }),
        expect.objectContaining({
          displayName: 'Nano Banana 2',
          enabled: true,
          id: 'google/gemini-3.1-flash-image-preview:image',
          parameters: { prompt: { default: '' } },
          type: 'image',
        }),
        expect.objectContaining({
          displayName: 'Text Embedding 3 Small',
          enabled: true,
          id: 'openai/text-embedding-3-small',
          type: 'embedding',
        }),
      ]),
    );

    // The usage ledger bounds a hold by the model's own output cap.
    const pricingRows = await catalog.listPricingRows();
    expect(pricingRows.find((row) => row.id === 'openai/gpt-4o')?.maxOutput).toBe(16_384);
    expect(pricingRows.find((row) => row.id === 'openrouter/auto')?.maxOutput).toBeNull();
  });

  it('records failure status when OpenRouter fetch throws', async () => {
    fetchOpenRouterModels.mockRejectedValue(new Error('network down'));

    const { OpenRouterModelCatalogSyncService } = await import('./modelCatalogSync');
    const service = new OpenRouterModelCatalogSyncService(db);
    const status = await service.sync('cron');

    expect(status).toMatchObject({
      lastError: 'network down',
      lastStatus: 'error',
      lastTriggeredBy: 'cron',
    });
  });
  it('keeps the previous catalog when upstream returns a truncated list', async () => {
    const chat = (id: string) => ({ displayName: id, id, type: 'chat' });
    fetchOpenRouterModels.mockResolvedValue(['a/1', 'a/2', 'a/3', 'a/4', 'a/5', 'a/6'].map(chat));

    const { OpenRouterModelCatalogSyncService } = await import('./modelCatalogSync');
    const service = new OpenRouterModelCatalogSyncService(db);
    expect((await service.sync('cron')).lastStatus).toBe('success');

    fetchOpenRouterModels.mockResolvedValue([chat('a/1')]);
    const status = await service.sync('cron');

    expect(status.lastStatus).toBe('error');
    expect(status.lastError).toContain('Refused catalog with 1 chat models (had 6)');
    const ids = (await new OpenRouterModelCatalogModel(db).listPricingRows()).map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining(['a/1', 'a/2', 'a/3', 'a/4', 'a/5', 'a/6']));

    // A full-size list still replaces the catalog, including removals.
    fetchOpenRouterModels.mockResolvedValue(['a/1', 'a/2', 'a/3', 'a/4', 'a/5'].map(chat));
    expect((await service.sync('cron')).lastStatus).toBe('success');
    const after = (await new OpenRouterModelCatalogModel(db).listPricingRows()).map((r) => r.id);
    expect(after).not.toContain('a/6');
  });
});

describe('catalogFetchRejection', () => {
  const priced = { units: [] };
  const chat = (id: string, pricing?: unknown) =>
    ({ id, pricing, type: 'chat' }) as unknown as ChatModelCard;

  it('accepts a first sync into an empty catalog', async () => {
    const { catalogFetchRejection } = await import('./modelCatalogSync');
    expect(
      catalogFetchRejection({ existingChatCount: 0, fetched: [chat('a')], requirePricing: false }),
    ).toBeNull();
  });

  it('refuses a coefficient catalog where no chat model is priced', async () => {
    const { catalogFetchRejection } = await import('./modelCatalogSync');
    const fetched = [chat('a'), chat('b')];
    expect(
      catalogFetchRejection({ existingChatCount: 2, fetched, requirePricing: true }),
    ).toContain('no priced chat models');
    expect(
      catalogFetchRejection({ existingChatCount: 2, fetched, requirePricing: false }),
    ).toBeNull();
    expect(
      catalogFetchRejection({
        existingChatCount: 2,
        fetched: [chat('a', priced), chat('b')],
        requirePricing: true,
      }),
    ).toBeNull();
  });
});
