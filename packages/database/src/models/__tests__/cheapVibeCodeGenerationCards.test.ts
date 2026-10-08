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
  it('adds the image and video generators a text-only /v1/models never lists', async () => {
    const { OpenRouterModelCatalogModel } = await import('../openrouterModelCatalog');
    const catalog = new OpenRouterModelCatalogModel(db);

    await catalog.replaceCatalog({
      models: [{ id: 'claude-fable-5', type: 'chat' }],
      triggeredBy: 'test',
    });

    const models = byId(await catalog.listAsProviderModels());

    for (const id of [
      'gpt-image-2',
      'gpt-image-2.5-sunburst',
      'gpt-image-2.5-flare',
      'nano-banana-2',
      'grok-imagine-image',
    ]) {
      expect(models[id]).toMatchObject({ enabled: true, type: 'image' });
    }
    expect(models['grok-imagine-video']).toMatchObject({ enabled: true, type: 'video' });
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
    // Nano Banana 2: aspect + resolution (Gemini surface) plus thinking level.
    expect((models['nano-banana-2'] as any).parameters.reasoningEffort).toEqual({
      default: 'medium',
      enum: ['low', 'medium', 'high'],
    });
    expect((models['nano-banana-2'] as any).parameters.aspectRatio.default).toBe('auto');
    expect((models['nano-banana-2'] as any).parameters.resolution).toEqual({
      default: '1K',
      enum: ['512', '1K', '2K', '4K'],
    });
    // Nano Banana 2: single 100K-token tier per image on CVC.
    expect(models['nano-banana-2'].pricing?.approximatePricePerImage).toEqual(expect.any(Number));
    expect((models['nano-banana-2'] as any).pricing?.units?.[0]).toMatchObject({
      name: 'imageGeneration',
      strategy: 'fixed',
      unit: 'image',
    });
    // Grok Imagine Image keeps aspect + resolution (xAI / CVC video field names).
    expect((models['grok-imagine-image'] as any).parameters.aspectRatio.default).toBe('auto');
    expect((models['grok-imagine-image'] as any).parameters.resolution).toEqual({
      default: '1k',
      enum: ['1k', '2k'],
    });
    expect((models['grok-imagine-image'] as any).parameters.reasoningEffort).toBeUndefined();
    // Grok Imagine Image: quality-tiered CVC fee (auto billed as medium).
    expect(models['grok-imagine-image'].pricing?.approximatePricePerImage).toEqual(
      expect.any(Number),
    );
    expect((models['grok-imagine-image'] as any).pricing?.units?.[0]).toMatchObject({
      name: 'imageGeneration',
      strategy: 'lookup',
      unit: 'image',
    });
    expect(
      (
        (models['grok-imagine-image'] as any).pricing?.units?.[0] as {
          lookup?: { prices?: object };
        }
      ).lookup?.prices,
    ).toMatchObject({
      auto: expect.any(Number),
      high: expect.any(Number),
      low: expect.any(Number),
      medium: expect.any(Number),
    });
    // Resolution × source lookup so the chat confirm card price moves with quality.
    expect(models['grok-imagine-video'].pricing?.units?.[0]).toMatchObject({
      name: 'videoGeneration',
      strategy: 'lookup',
      unit: 'second',
    });
    expect(
      (models['grok-imagine-video'].pricing?.units?.[0] as { lookup?: { prices?: object } }).lookup
        ?.prices,
    ).toMatchObject({
      '480p_text': expect.any(Number),
      '720p_text': expect.any(Number),
      '480p_image': expect.any(Number),
      '720p_image': expect.any(Number),
    });
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
    expect(models['grok-imagine-video']).toMatchObject({ type: 'video' });
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

  it('lets GPT Image 2 take several reference images and Grok Imagine Video one start frame', async () => {
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
    // CheapVibeCode rejects `reference_images`, so the video card must not offer several.
    expect(models['grok-imagine-video'].parameters.imageUrl).toEqual({ default: null });
    expect(models['grok-imagine-video'].parameters.imageUrls).toBeUndefined();
  });

  it('offers an image upload for Grok Imagine Video even from a row synced before it', async () => {
    const { OpenRouterModelCatalogModel } = await import('../openrouterModelCatalog');
    await db.insert(openrouterModelCatalog).values([
      { enabled: true, id: 'openrouter/auto', payload: {}, syncedAt: new Date(), type: 'chat' },
      {
        enabled: true,
        id: 'grok-imagine-video',
        // Text-to-video-only schema persisted by an earlier sync.
        payload: { parameters: { duration: { default: 6 }, prompt: { default: '' } } },
        syncedAt: new Date(),
        type: 'video',
      },
    ]);

    const video = byId(await new OpenRouterModelCatalogModel(db).listAsProviderModels())[
      'grok-imagine-video'
    ] as any;

    expect(video.parameters.imageUrl).toEqual({ default: null });
    expect(video.enabled).toBe(true);
  });

  it('overlays Grok Imagine Video pricing on a row synced without a price table', async () => {
    const { OpenRouterModelCatalogModel } = await import('../openrouterModelCatalog');
    await db.insert(openrouterModelCatalog).values([
      { enabled: true, id: 'openrouter/auto', payload: {}, syncedAt: new Date(), type: 'chat' },
      {
        enabled: true,
        id: 'grok-imagine-video',
        payload: { parameters: { duration: { default: 6 }, prompt: { default: '' } } },
        pricing: null,
        syncedAt: new Date(),
        type: 'video',
      },
    ]);

    const video = byId(await new OpenRouterModelCatalogModel(db).listAsProviderModels())[
      'grok-imagine-video'
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

    await catalog.setModelsEnabled(['grok-imagine-video'], false);
    await catalog.replaceCatalog({
      models: [{ id: 'glm-5.3', type: 'chat' }],
      triggeredBy: 'cron',
    });

    expect(byId(await catalog.listAsProviderModels())['grok-imagine-video'].enabled).toBe(false);
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
