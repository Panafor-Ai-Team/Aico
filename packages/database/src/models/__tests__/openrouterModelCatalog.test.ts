import { beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import {
  openrouterModelCatalog,
  openrouterModelSyncRuns,
  openrouterModelSyncState,
} from '../../schemas';
import type { LobeChatDatabase } from '../../type';
import { OpenRouterModelCatalogModel } from '../openrouterModelCatalog';

let db: LobeChatDatabase;
let catalog: OpenRouterModelCatalogModel;

beforeEach(async () => {
  db = await getTestDB();
  await db.delete(openrouterModelCatalog);
  await db.delete(openrouterModelSyncState);
  await db.delete(openrouterModelSyncRuns);
  catalog = new OpenRouterModelCatalogModel(db);
}, 30_000);

describe('OpenRouterModelCatalogModel', () => {
  it('lists pricing rows with the output cap kept in the payload', async () => {
    await catalog.replaceCatalog({
      models: [
        {
          contextWindowTokens: 200_000,
          id: 'glm-5.3-flash',
          maxOutput: 32_000,
          pricing: {
            units: [{ name: 'textInput', rate: 0.012, strategy: 'fixed', unit: 'millionTokens' }],
          },
          type: 'chat',
        },
        { id: 'no-cap', type: 'chat' },
      ],
      triggeredBy: 'test',
    });

    const rows = await catalog.listPricingRows();
    expect(rows.find((row) => row.id === 'glm-5.3-flash')).toMatchObject({
      contextWindowTokens: 200_000,
      maxOutput: 32_000,
      type: 'chat',
    });
    expect(rows.find((row) => row.id === 'no-cap')?.maxOutput).toBeNull();
  });

  it('starts with never-synced status', async () => {
    await expect(catalog.getSyncStatus()).resolves.toMatchObject({
      lastStatus: 'never',
      modelCount: 0,
    });
    await expect(catalog.count()).resolves.toBe(0);
  });

  it('enables every model in a fresh snapshot, whatever its family or age', async () => {
    await catalog.replaceCatalog({
      models: [
        { displayName: 'GPT old', id: 'openai/gpt-old', releasedAt: '2024-01-01', type: 'chat' },
        { displayName: 'GPT 1', id: 'openai/gpt-1', releasedAt: '2024-06-01', type: 'chat' },
        { displayName: 'GPT 2', id: 'openai/gpt-2', releasedAt: '2025-01-01', type: 'chat' },
        { displayName: 'GPT 3', id: 'openai/gpt-3', releasedAt: '2025-06-01', type: 'chat' },
        { displayName: 'GPT 4', id: 'openai/gpt-4', releasedAt: '2025-12-01', type: 'chat' },
        {
          displayName: 'Claude',
          id: 'anthropic/claude-1',
          releasedAt: '2025-01-01',
          type: 'chat',
        },
        {
          displayName: 'Gemini',
          id: 'google/gemini-1',
          releasedAt: '2025-01-01',
          type: 'chat',
        },
        {
          displayName: 'DeepSeek',
          id: 'deepseek/deepseek-chat',
          releasedAt: '2026-01-01',
          type: 'chat',
        },
        {
          displayName: 'DALL-E',
          id: 'openai/dall-e',
          releasedAt: '2026-01-01',
          type: 'image',
        },
        {
          displayName: 'Veo 3',
          id: 'google/veo-3',
          releasedAt: '2026-01-01',
          type: 'video',
        },
      ],
      triggeredBy: 'manual:admin',
    });

    const rows = await catalog.listAsProviderModels();
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));

    expect(byId['openai/gpt-4'].enabled).toBe(true);
    expect(byId['openai/gpt-3'].enabled).toBe(true);
    expect(byId['openai/gpt-2'].enabled).toBe(true);
    expect(byId['openai/gpt-1'].enabled).toBe(true);
    expect(byId['anthropic/claude-1'].enabled).toBe(true);
    expect(byId['google/gemini-1'].enabled).toBe(true);
    expect(byId['openai/dall-e'].enabled).toBe(true);
    expect(byId['google/veo-3'].enabled).toBe(true);
    // Neither the oldest model of a curated family nor a vendor outside
    // openai/anthropic/google is held back any more — the admin decides.
    expect(byId['openai/gpt-old'].enabled).toBe(true);
    expect(byId['deepseek/deepseek-chat'].enabled).toBe(true);

    const status = await catalog.getSyncStatus();
    expect(status).toMatchObject({
      lastStatus: 'success',
      lastTriggeredBy: 'manual:admin',
      // Input models + product Auto + injected embedding cards
      modelCount: 12,
    });
  });

  it('preserves an admin-set enabled flag across a re-sync, and enables new ids', async () => {
    await catalog.replaceCatalog({
      models: [
        { displayName: 'GPT-A', id: 'openai/gpt-a', releasedAt: '2025-01-01', type: 'chat' },
        { displayName: 'Claude', id: 'anthropic/claude-a', releasedAt: '2025-01-01', type: 'chat' },
      ],
      triggeredBy: 'manual:admin',
    });

    // The admin turns one model off. A sync must not undo that.
    await catalog.setModelsEnabled(['openai/gpt-a'], false);

    await catalog.replaceCatalog({
      models: [
        {
          displayName: 'GPT-A refreshed',
          id: 'openai/gpt-a',
          releasedAt: '2024-01-01',
          type: 'chat',
        },
        { displayName: 'GPT-B', id: 'openai/gpt-b', releasedAt: '2026-01-01', type: 'chat' },
        { displayName: 'Gemini', id: 'google/gemini-b', releasedAt: '2025-06-01', type: 'chat' },
      ],
      triggeredBy: 'cron',
    });

    const rows = await catalog.listAsProviderModels();
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));

    // Still off, while every other column refreshes from the snapshot.
    expect(byId['openai/gpt-a'].enabled).toBe(false);
    expect(byId['openai/gpt-a'].displayName).toBe('GPT-A refreshed');
    // Ids the catalog has not seen before arrive enabled.
    expect(byId['openai/gpt-b'].enabled).toBe(true);
    expect(byId['google/gemini-b'].enabled).toBe(true);
    expect(byId['anthropic/claude-a']).toBeUndefined();

    const status = await catalog.getSyncStatus();
    expect(status).toMatchObject({
      lastStatus: 'success',
      lastTriggeredBy: 'cron',
      // Remaining models + product Auto + injected embedding cards
      modelCount: 5,
    });
    expect(status.lastSyncedAt).toBeTruthy();
  });

  it('turns models back on in bulk', async () => {
    await catalog.replaceCatalog({
      models: [
        { displayName: 'GPT-A', id: 'openai/gpt-a', releasedAt: '2025-01-01', type: 'chat' },
        { displayName: 'GPT-B', id: 'openai/gpt-b', releasedAt: '2025-01-01', type: 'chat' },
      ],
      triggeredBy: 'manual:admin',
    });

    await catalog.setModelsEnabled(['openai/gpt-a', 'openai/gpt-b'], false);
    await expect(catalog.setModelsEnabled(['openai/gpt-a', 'openai/gpt-b'], true)).resolves.toBe(2);

    const byId = Object.fromEntries((await catalog.listAsProviderModels()).map((r) => [r.id, r]));
    expect(byId['openai/gpt-a'].enabled).toBe(true);
    expect(byId['openai/gpt-b'].enabled).toBe(true);
  });

  it('records sync errors without clearing prior success metadata', async () => {
    await catalog.replaceCatalog({
      models: [{ displayName: 'X', id: 'openai/x', type: 'chat' }],
      triggeredBy: 'cron',
    });

    const afterError = await catalog.markSyncError({
      error: 'OpenRouter down',
      triggeredBy: 'manual:ops',
    });

    expect(afterError).toMatchObject({
      lastError: 'OpenRouter down',
      lastStatus: 'error',
      lastTriggeredBy: 'manual:ops',
      // openai/x + product Auto + injected embedding cards
      modelCount: 3,
    });
    expect(afterError.lastSyncedAt).toBeTruthy();

    const history = await catalog.listSyncRuns(10);
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({
      error: 'OpenRouter down',
      status: 'error',
      triggeredBy: 'manual:ops',
    });
    expect(history[1]).toMatchObject({
      addedModelIds: expect.arrayContaining(['openai/x']),
      status: 'success',
      triggeredBy: 'cron',
    });
  });

  it('records added and removed model ids across syncs', async () => {
    await catalog.replaceCatalog({
      models: [
        { displayName: 'A', id: 'openai/a', type: 'chat' },
        { displayName: 'B', id: 'openai/b', type: 'chat' },
      ],
      triggeredBy: 'manual:1',
    });

    await catalog.replaceCatalog({
      models: [
        { displayName: 'B', id: 'openai/b', type: 'chat' },
        { displayName: 'C', id: 'openai/c', type: 'chat' },
      ],
      triggeredBy: 'manual:2',
    });

    const [latest] = await catalog.listSyncRuns(1);
    expect(latest).toMatchObject({
      addedModelIds: ['openai/c'],
      removedModelIds: ['openai/a'],
      status: 'success',
      triggeredBy: 'manual:2',
    });
  });

  it('injects the default embedding model even when the live sync omits it, and keeps it enabled', async () => {
    await catalog.replaceCatalog({
      models: [{ displayName: 'GPT-A', id: 'openai/gpt-a', type: 'chat' }],
      triggeredBy: 'manual:admin',
    });

    const rows = await catalog.listAsProviderModels();
    const embedding = rows.find((r) => r.id === 'openai/text-embedding-3-small');
    expect(embedding).toMatchObject({ enabled: true, type: 'embedding' });

    // Stays present and enabled across a re-sync too, same as product Auto.
    await catalog.replaceCatalog({
      models: [{ displayName: 'GPT-B', id: 'openai/gpt-b', type: 'chat' }],
      triggeredBy: 'cron',
    });
    const rowsAfterResync = await catalog.listAsProviderModels();
    expect(rowsAfterResync.find((r) => r.id === 'openai/text-embedding-3-small')).toMatchObject({
      enabled: true,
    });
  });

  it('backfills the default embedding model on the serve path for catalogs synced before the injection', async () => {
    const now = new Date();
    // Simulate a catalog synced before the embedding injection: rows written
    // directly, bypassing replaceCatalog, so no embedding row exists.
    await db.insert(openrouterModelCatalog).values([
      {
        displayName: 'GPT-A',
        enabled: true,
        id: 'openai/gpt-a',
        payload: {},
        releasedAt: '2025-01-01',
        syncedAt: now,
        type: 'chat',
      },
      {
        displayName: 'Panachat Auto',
        enabled: true,
        id: 'openrouter/auto',
        payload: {},
        syncedAt: now,
        type: 'chat',
      },
    ]);

    const rows = await catalog.listAsProviderModels();
    expect(rows.find((r) => r.id === 'openai/text-embedding-3-small')).toMatchObject({
      enabled: true,
      type: 'embedding',
    });
  });

  it('reseeds default enabled flags from existing rows', async () => {
    const now = new Date();
    await db.insert(openrouterModelCatalog).values([
      {
        enabled: true,
        id: 'deepseek/old',
        payload: {},
        releasedAt: '2026-01-01',
        syncedAt: now,
        type: 'chat',
      },
      {
        enabled: false,
        id: 'openai/new',
        payload: {},
        releasedAt: '2025-12-01',
        syncedAt: now,
        type: 'chat',
      },
    ]);

    await expect(catalog.reseedDefaultEnabledFlags()).resolves.toBe(2);

    const rows = await catalog.listAsProviderModels();
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId['openai/new'].enabled).toBe(true);
    expect(byId['deepseek/old'].enabled).toBe(false);
  });

  it('recovers the published CVC coefficient from the synced pricing', async () => {
    // Regression: the sync stores the coefficient only as pricing, so reading
    // `payload.multiplier` showed every model as unpublished (x1.00 in the admin
    // table), inviting an override that stacked on top of the real coefficient.
    const cvcUnit = (rate: number) => ({
      units: [
        {
          name: 'textInput' as const,
          rate,
          strategy: 'fixed' as const,
          unit: 'millionTokens' as const,
        },
      ],
    });
    await catalog.replaceCatalog({
      models: [
        { id: 'claude-opus-5', pricing: cvcUnit(0.16), type: 'chat' },
        { id: 'gpt-5.6-luna', pricing: cvcUnit(0.0132), type: 'chat' },
        { id: 'unpriced', type: 'chat' },
      ],
      triggeredBy: 'test',
    });

    const byId = (list: { id: string; publishedBp: number | null }[]) =>
      Object.fromEntries(list.map((row) => [row.id, row.publishedBp]));

    const cvc = byId(await catalog.listCoefficients({ tokensPerUsd: 25_000_000 }));
    expect(cvc['claude-opus-5']).toBe(40_000);
    expect(cvc['gpt-5.6-luna']).toBe(3300);
    expect(cvc['unpriced']).toBeNull();

    // Providers without a published coefficient (OpenRouter) omit the rate.
    expect(byId(await catalog.listCoefficients())['claude-opus-5']).toBeNull();
  });
});
