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

    for (const id of ['gpt-image-2', 'nano-banana-2', 'grok-imagine-image']) {
      expect(models[id]).toMatchObject({ enabled: true, type: 'image' });
    }
    expect(models['grok-imagine-video']).toMatchObject({ enabled: true, type: 'video' });
    // GPT Image 2 defaults to medium quality.
    expect((models['gpt-image-2'] as any).parameters.quality.default).toBe('medium');
    // Nano Banana 2 exposes thinking level (reasoning_effort on the wire).
    expect((models['nano-banana-2'] as any).parameters.reasoningEffort).toEqual({
      default: 'medium',
      enum: ['low', 'medium', 'high'],
    });
    // Grok Imagine Image stays prompt-only — no undocumented fields.
    expect((models['grok-imagine-image'] as any).parameters.reasoningEffort).toBeUndefined();
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
    expect(models['grok-imagine-video']).toMatchObject({ type: 'video' });
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
