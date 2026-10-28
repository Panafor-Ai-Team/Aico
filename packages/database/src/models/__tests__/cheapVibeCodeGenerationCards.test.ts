import type * as BusinessConst from '@lobechat/business-const';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import {
  openrouterModelCatalog,
  openrouterModelSyncRuns,
  openrouterModelSyncState,
} from '../../schemas';
import type { LobeChatDatabase } from '../../type';

vi.mock('@lobechat/business-const', async (importOriginal) => ({
  ...(await importOriginal<typeof BusinessConst>()),
  MANAGED_PROVIDER_ID: 'cheapvibecode',
}));

let db: LobeChatDatabase;

beforeEach(async () => {
  db = await getTestDB();
  await db.delete(openrouterModelCatalog);
  await db.delete(openrouterModelSyncRuns);
  await db.delete(openrouterModelSyncState);
}, 30_000);

const byId = <T extends { id: string }>(rows: T[]) =>
  Object.fromEntries(rows.map((row) => [row.id, row])) as Record<string, T>;

describe('CheapVibeCode generation models', () => {
  it('adds the media models a text-only /v1/models never lists', async () => {
    const { OpenRouterModelCatalogModel } = await import('../openrouterModelCatalog');
    const catalog = new OpenRouterModelCatalogModel(db);

    await catalog.replaceCatalog({
      models: [{ id: 'claude-fable-5', type: 'chat' }],
      triggeredBy: 'test',
    });

    const models = byId(await catalog.listAsProviderModels());

    for (const id of ['gpt-image-2', 'gpt-image-2.5-sunburst', 'gpt-image-2.5-flare']) {
      expect(models[id]).toMatchObject({ enabled: true, type: 'image' });
    }
    expect(models['kling-video-v3']).toMatchObject({ enabled: true, type: 'video' });
    expect(models['minimax-video-h3']).toMatchObject({ enabled: true, type: 'video' });
    expect(models['gpt-4o-transcribe']).toMatchObject({ enabled: true, type: 'asr' });
    // Retired from CVC's media list (2026-10-28).
    for (const id of ['nano-banana-2', 'grok-imagine-image', 'grok-imagine-video']) {
      expect(models[id]).toBeUndefined();
    }
    // GPT Image 2 defaults to medium quality.
    expect((models['gpt-image-2'] as any).parameters.quality.default).toBe('medium');
    // GPT Image 2 shares the 2.5 quality-tiered fee (CVC prices them the same),
    // so it must serve the same lookup table, not a priceless card.
    expect(models['gpt-image-2'].pricing?.approximatePricePerImage).toEqual(expect.any(Number));
    expect((models['gpt-image-2'] as any).pricing?.units?.[0]).toMatchObject({
      name: 'imageGeneration',
      strategy: 'lookup',
      unit: 'image',
    });
    expect(
      ((models['gpt-image-2'] as any).pricing?.units?.[0] as { lookup?: { prices?: object } })
        .lookup?.prices,
    ).toMatchObject({
      auto: expect.any(Number),
      high: expect.any(Number),
      low: expect.any(Number),
      medium: expect.any(Number),
    });
    // GPT Image 2.5 Sunburst / Flare: same Images surface as GPT Image 2, plus
    // quality-tiered fixed CVC token pricing.
    for (const id of ['gpt-image-2.5-sunburst', 'gpt-image-2.5-flare']) {
      expect((models[id] as any).parameters.quality).toEqual({
        default: 'medium',
        enum: ['low', 'medium', 'high', 'auto'],
      });
      expect((models[id] as any).parameters.size.enum).toEqual(
        expect.arrayContaining([
          'auto',
          '1024x1024',
          '1536x1024',
          '1024x1536',
          '2048x2048',
          '2048x1152',
          '3840x2160',
          '2160x3840',
        ]),
      );
      expect((models[id] as any).parameters.imageUrls.maxCount).toBe(16);
      expect(models[id].pricing?.approximatePricePerImage).toEqual(expect.any(Number));
      expect(models[id].pricing?.units?.[0]).toMatchObject({
        name: 'imageGeneration',
        strategy: 'lookup',
        unit: 'image',
      });
      expect(
        (models[id].pricing?.units?.[0] as { lookup?: { prices?: object } }).lookup?.prices,
      ).toMatchObject({
        auto: expect.any(Number),
        high: expect.any(Number),
        low: expect.any(Number),
        medium: expect.any(Number),
      });
    }
    // CVC docs: quality=auto is charged as low.
    const gptImagePrices = ((models['gpt-image-2'] as any).pricing?.units?.[0] as any).lookup
      .prices;
    expect(gptImagePrices.auto).toBe(gptImagePrices.low);
    // Kling: resolution × audio per-second lookup.
    expect(((models['kling-video-v3'] as any).pricing?.units?.[0] as any).lookup).toMatchObject({
      prices: {
        '1080p_false': expect.any(Number),
        '1080p_true': expect.any(Number),
        '4k_false': expect.any(Number),
        '4k_true': expect.any(Number),
        '720p_false': expect.any(Number),
        '720p_true': expect.any(Number),
      },
      pricingParams: ['resolution', 'generateAudio'],
    });
    expect((models['kling-video-v3'] as any).parameters.duration).toMatchObject({
      max: 15,
      min: 3,
    });
    expect((models['minimax-video-h3'] as any).parameters.imageUrls.maxCount).toBe(4);
    expect((models['minimax-video-h3'] as any).parameters.resolution.enum).toEqual(['768p', '2k']);
  });

  it('stops serving retired media and embedding rows before the next sync deletes them', async () => {
    const { OpenRouterModelCatalogModel } = await import('../openrouterModelCatalog');
    const now = new Date();
    await db.insert(openrouterModelCatalog).values(
      [
        ['openrouter/auto', 'chat'],
        ['glm-5.3', 'chat'],
        ['grok-imagine-video', 'video'],
        ['grok-imagine-image', 'image'],
        ['nano-banana-2', 'image'],
        ['openai/text-embedding-3-small', 'embedding'],
      ].map(([id, type]) => ({ enabled: true, id, payload: {}, syncedAt: now, type })),
    );

    const models = byId(await new OpenRouterModelCatalogModel(db).listAsProviderModels());

    for (const id of [
      'grok-imagine-video',
      'grok-imagine-image',
      'nano-banana-2',
      'openai/text-embedding-3-small',
    ]) {
      expect(models[id]).toBeUndefined();
    }
    expect(models['glm-5.3']).toBeDefined();
    expect(models['kling-video-v3']).toMatchObject({ type: 'video' });
    expect(models['google/gemini-embedding-2']).toMatchObject({ type: 'embedding' });
  });

  it('backfills them on the serve path for a catalog synced before they existed', async () => {
    const { OpenRouterModelCatalogModel } = await import('../openrouterModelCatalog');
    await db.insert(openrouterModelCatalog).values({
      enabled: true,
      id: 'openrouter/auto',
      payload: {},
      syncedAt: new Date(),
      type: 'chat',
    });

    const models = byId(await new OpenRouterModelCatalogModel(db).listAsProviderModels());

    expect(models['gpt-image-2']).toMatchObject({ type: 'image' });
    expect(models['gpt-image-2.5-sunburst']).toMatchObject({ type: 'image' });
    expect(models['gpt-image-2.5-flare']).toMatchObject({ type: 'image' });
    expect(models['kling-video-v3']).toMatchObject({ type: 'video' });
  });

  it('overlays GPT Image 2.5 pricing and quality schema on a row synced without them', async () => {
    const { OpenRouterModelCatalogModel } = await import('../openrouterModelCatalog');
    await db.insert(openrouterModelCatalog).values([
      { enabled: true, id: 'openrouter/auto', payload: {}, syncedAt: new Date(), type: 'chat' },
      {
        enabled: true,
        id: 'gpt-image-2.5-sunburst',
        payload: { parameters: { prompt: { default: '' } } },
        pricing: null,
        syncedAt: new Date(),
        type: 'image',
      },
    ]);

    const model = byId(await new OpenRouterModelCatalogModel(db).listAsProviderModels())[
      'gpt-image-2.5-sunburst'
    ] as any;

    expect(model.parameters.quality.default).toBe('medium');
    expect(model.parameters.imageUrls.maxCount).toBe(16);
    expect(model.parameters.size.enum).toEqual(
      expect.arrayContaining(['auto', '1024x1024', '3840x2160', '2160x3840']),
    );
    expect(model.description).toMatch(/Sunburst/);
    expect(model.pricing?.units?.[0]).toMatchObject({
      name: 'imageGeneration',
      strategy: 'lookup',
    });
  });

  it('lets GPT Image 2 take several reference images and Kling one first and last frame', async () => {
    const { OpenRouterModelCatalogModel } = await import('../openrouterModelCatalog');
    await db.insert(openrouterModelCatalog).values([
      { enabled: true, id: 'openrouter/auto', payload: {}, syncedAt: new Date(), type: 'chat' },
      {
        enabled: true,
        id: 'gpt-image-2',
        // Single-image schema persisted by an earlier sync.
        payload: { parameters: { imageUrls: { default: [], maxCount: 1 }, prompt: {} } },
        syncedAt: new Date(),
        type: 'image',
      },
    ]);

    const models = byId(await new OpenRouterModelCatalogModel(db).listAsProviderModels()) as any;

    expect(models['gpt-image-2'].parameters.imageUrls.maxCount).toBe(16);
    expect(models['gpt-image-2'].parameters.quality.default).toBe('medium');
    // Kling takes frames, not `reference_images`, so it must not offer several.
    expect(models['kling-video-v3'].parameters.imageUrl).toEqual({ default: null });
    expect(models['kling-video-v3'].parameters.endImageUrl).toEqual({ default: null });
    expect(models['kling-video-v3'].parameters.imageUrls).toBeUndefined();
  });

  it('offers an image upload for Kling Video V3 even from a row synced before it', async () => {
    const { OpenRouterModelCatalogModel } = await import('../openrouterModelCatalog');
    await db.insert(openrouterModelCatalog).values([
      { enabled: true, id: 'openrouter/auto', payload: {}, syncedAt: new Date(), type: 'chat' },
      {
        enabled: true,
        id: 'kling-video-v3',
        // Text-to-video-only schema persisted by an earlier sync.
        payload: { parameters: { duration: { default: 5 }, prompt: { default: '' } } },
        syncedAt: new Date(),
        type: 'video',
      },
    ]);

    const video = byId(await new OpenRouterModelCatalogModel(db).listAsProviderModels())[
      'kling-video-v3'
    ] as any;

    expect(video.parameters.imageUrl).toEqual({ default: null });
    expect(video.enabled).toBe(true);
  });

  it('overlays Kling Video V3 pricing on a row synced without a price table', async () => {
    const { OpenRouterModelCatalogModel } = await import('../openrouterModelCatalog');
    await db.insert(openrouterModelCatalog).values([
      { enabled: true, id: 'openrouter/auto', payload: {}, syncedAt: new Date(), type: 'chat' },
      {
        enabled: true,
        id: 'kling-video-v3',
        payload: { parameters: { duration: { default: 5 }, prompt: { default: '' } } },
        pricing: null,
        syncedAt: new Date(),
        type: 'video',
      },
    ]);

    const video = byId(await new OpenRouterModelCatalogModel(db).listAsProviderModels())[
      'kling-video-v3'
    ];

    expect(video.pricing?.units?.[0]).toMatchObject({
      name: 'videoGeneration',
      strategy: 'lookup',
    });
  });

  it('keeps an admin switching a generator off across the next sync', async () => {
    const { OpenRouterModelCatalogModel } = await import('../openrouterModelCatalog');
    const catalog = new OpenRouterModelCatalogModel(db);
    await catalog.replaceCatalog({
      models: [{ id: 'glm-5.3', type: 'chat' }],
      triggeredBy: 'test',
    });

    await catalog.setModelsEnabled(['kling-video-v3'], false);
    await catalog.replaceCatalog({
      models: [{ id: 'glm-5.3', type: 'chat' }],
      triggeredBy: 'cron',
    });

    expect(byId(await catalog.listAsProviderModels())['kling-video-v3'].enabled).toBe(false);
  });

  it('backfills reasoningEffort on reasoning chat models missing the extendParam', async () => {
    const { OpenRouterModelCatalogModel } = await import('../openrouterModelCatalog');
    await db.insert(openrouterModelCatalog).values({
      abilities: { reasoning: true },
      enabled: true,
      id: 'gpt-5.6-terra',
      payload: {},
      settings: {},
      syncedAt: new Date(),
      type: 'chat',
    });

    const models = byId(await new OpenRouterModelCatalogModel(db).listAsProviderModels());

    expect(models['gpt-5.6-terra'].settings?.extendParams).toContain('reasoningEffort');
  });
});
