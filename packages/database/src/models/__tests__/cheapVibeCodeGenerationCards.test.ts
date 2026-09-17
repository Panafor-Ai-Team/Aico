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
});
