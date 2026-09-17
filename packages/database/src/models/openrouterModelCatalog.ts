import {
  computeDefaultEnabledOpenRouterModelIds,
  ensureOpenRouterAutoModel,
  ensureOpenRouterModels,
  MANAGED_PROVIDER_ID,
  OPENROUTER_AUTO_DISPLAY_NAME,
  OPENROUTER_AUTO_MODEL_ID,
} from '@lobechat/business-const';
import { asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { AiProviderModelListItem, ModelAbilities, Pricing } from 'model-bank';
import { AiModelSourceEnum, normalizeAiModelType } from 'model-bank';
import {
  cheapVibeCodePromptOnlyImageParameters,
  gptImage2Schema,
} from 'model-bank/imageParameters';
import { cheapVibeCodeGrokImagineVideoParameters } from 'model-bank/videoParameters';

import {
  type NewOpenrouterModelCatalog,
  openrouterModelCatalog,
  openrouterModelSyncRuns,
  openrouterModelSyncState,
} from '../schemas';
import type { LobeChatDatabase } from '../type';

export type OpenRouterCatalogSyncStatus = {
  lastError: string | null;
  lastStatus: string;
  lastSyncedAt: string | null;
  lastTriggeredBy: string | null;
  modelCount: number;
};

export type OpenRouterCatalogSyncRun = {
  addedModelIds: string[];
  error: string | null;
  id: string;
  modelCount: number;
  removedModelIds: string[];
  status: string;
  syncedAt: string;
  triggeredBy: string | null;
};

export type OpenRouterCatalogModelInput = {
  abilities?: ModelAbilities;
  contextWindowTokens?: number;
  description?: string;
  displayName?: string;
  enabled?: boolean;
  id: string;
  pricing?: Pricing;
  releasedAt?: string;
  settings?: AiProviderModelListItem['settings'];
  type?: string;
  /** Extra fields preserved in payload JSON. */
  [key: string]: unknown;
};

const SYNC_STATE_ID = 'default';

const AUTO_CATALOG_CARD: OpenRouterCatalogModelInput = {
  contextWindowTokens: 2_000_000,
  description:
    'Routes each request to the best available model based on context length, topic, and complexity.',
  displayName: OPENROUTER_AUTO_DISPLAY_NAME,
  id: OPENROUTER_AUTO_MODEL_ID,
  type: 'chat',
};

/**
 * OpenRouter serves embeddings through a dedicated `/embeddings` endpoint, not
 * through the general `/models` chat-completions listing this catalog syncs from
 * — so embedding models never appear in a live sync snapshot on their own. Inject
 * the ones the product relies on (system-agent memory embedding default) so they
 * exist in the catalog as ordinary rows, enabled like any other new id.
 */
const EMBEDDING_CATALOG_CARDS: OpenRouterCatalogModelInput[] = [
  {
    contextWindowTokens: 8192,
    description:
      'An efficient, cost-effective next-generation embedding model for retrieval and RAG scenarios.',
    displayName: 'Text Embedding 3 Small',
    id: 'openai/text-embedding-3-small',
    pricing: {
      units: [{ name: 'textInput', rate: 0.02, strategy: 'fixed', unit: 'millionTokens' }],
    },
    releasedAt: '2024-01-25',
    type: 'embedding',
  },
];

/**
 * CheapVibeCode's generators. Its `/v1/models` lists only text-output models, so
 * image and video generation never arrive through a sync; these are the models
 * its `/v1/images/generations` and `/v1/videos/generations` actually accept.
 * Injected only while CheapVibeCode is the live gateway, so an OpenRouter
 * catalog never offers ids its upstream would reject.
 */
const CHEAPVIBECODE_GENERATION_CATALOG_CARDS: OpenRouterCatalogModelInput[] = [
  { displayName: 'GPT Image 2', id: 'gpt-image-2', parameters: gptImage2Schema, type: 'image' },
  {
    displayName: 'Nano Banana 2',
    id: 'nano-banana-2',
    parameters: cheapVibeCodePromptOnlyImageParameters,
    type: 'image',
  },
  {
    displayName: 'Grok Imagine Image',
    id: 'grok-imagine-image',
    parameters: cheapVibeCodePromptOnlyImageParameters,
    type: 'image',
  },
  {
    displayName: 'Grok Imagine Video',
    id: 'grok-imagine-video',
    parameters: cheapVibeCodeGrokImagineVideoParameters,
    type: 'video',
  },
];

const managedGenerationCatalogCards = (): OpenRouterCatalogModelInput[] =>
  MANAGED_PROVIDER_ID === 'cheapvibecode' ? CHEAPVIBECODE_GENERATION_CATALOG_CARDS : [];

const toProviderCard = (card: OpenRouterCatalogModelInput): AiProviderModelListItem =>
  ({
    abilities: {},
    displayName: card.displayName,
    enabled: true,
    id: card.id,
    parameters: card.parameters,
    source: AiModelSourceEnum.Remote,
    type: normalizeAiModelType(card.type),
  }) as AiProviderModelListItem;

/**
 * Serve-path twin of {@link EMBEDDING_CATALOG_CARDS}: the exact card
 * `replaceCatalog` persists, so a stale catalog backfills byte-identical rows.
 */
const EMBEDDING_PROVIDER_CARDS: AiProviderModelListItem[] = EMBEDDING_CATALOG_CARDS.map((card) => ({
  abilities: {},
  contextWindowTokens: card.contextWindowTokens,
  description: card.description,
  displayName: card.displayName,
  enabled: true,
  id: card.id,
  pricing: card.pricing,
  releasedAt: card.releasedAt,
  source: AiModelSourceEnum.Remote,
  // These are embedding cards by construction; normalizeAiModelType widens to
  // `string | undefined` for unrecognised input.
  type: (normalizeAiModelType(card.type) ?? 'embedding') as AiProviderModelListItem['type'],
}));

export class OpenRouterModelCatalogModel {
  private db: LobeChatDatabase;

  constructor(db: LobeChatDatabase) {
    this.db = db;
  }

  /**
   * Pricing inputs for every catalog row, enabled or not: a disabled model may
   * still be reached through Auto, and it must be priced when it is.
   */
  listPricingRows = async () =>
    this.db
      .select({
        contextWindowTokens: openrouterModelCatalog.contextWindowTokens,
        id: openrouterModelCatalog.id,
        maxOutput: sql<
          number | null
        >`NULLIF(${openrouterModelCatalog.payload}->>'maxOutput', '')::int`,
        pricing: openrouterModelCatalog.pricing,
        type: openrouterModelCatalog.type,
      })
      .from(openrouterModelCatalog);

  getSyncStatus = async (): Promise<OpenRouterCatalogSyncStatus> => {
    const row = await this.db.query.openrouterModelSyncState.findFirst({
      where: eq(openrouterModelSyncState.id, SYNC_STATE_ID),
    });

    return {
      lastError: row?.lastError ?? null,
      lastStatus: row?.lastStatus ?? 'never',
      lastSyncedAt: row?.lastSyncedAt?.toISOString() ?? null,
      lastTriggeredBy: row?.lastTriggeredBy ?? null,
      modelCount: row?.modelCount ?? 0,
    };
  };

  listSyncRuns = async (limit = 20): Promise<OpenRouterCatalogSyncRun[]> => {
    const rows = await this.db
      .select()
      .from(openrouterModelSyncRuns)
      .orderBy(desc(openrouterModelSyncRuns.syncedAt))
      .limit(limit);

    return rows.map((row) => ({
      addedModelIds: row.addedModelIds ?? [],
      error: row.error ?? null,
      id: row.id,
      modelCount: row.modelCount,
      removedModelIds: row.removedModelIds ?? [],
      status: row.status,
      syncedAt: row.syncedAt.toISOString(),
      triggeredBy: row.triggeredBy ?? null,
    }));
  };

  count = async (): Promise<number> => {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(openrouterModelCatalog);
    return row?.count ?? 0;
  };

  /**
   * Model ids and their upstream-published cost coefficient, for the platform
   * admin's per-model override table (AICO-187).
   *
   * `publishedBp` is `null` for providers that do not publish a coefficient at
   * all (OpenRouter prices in USD per token), in which case an override is a
   * plain markup measured against 1.00x rather than a correction to a number
   * upstream told us.
   */
  listCoefficients = async (): Promise<
    Array<{
      displayName: string | null;
      enabled: boolean;
      id: string;
      publishedBp: number | null;
    }>
  > => {
    const rows = await this.db
      .select({
        displayName: openrouterModelCatalog.displayName,
        enabled: openrouterModelCatalog.enabled,
        id: openrouterModelCatalog.id,
        payload: openrouterModelCatalog.payload,
      })
      .from(openrouterModelCatalog)
      .orderBy(asc(openrouterModelCatalog.id));

    return rows.map((row) => {
      const raw = (row.payload as { multiplier?: unknown } | null)?.multiplier;
      const coefficient = typeof raw === 'number' ? raw : Number.NaN;
      return {
        displayName: row.displayName ?? null,
        enabled: row.enabled,
        id: row.id,
        publishedBp:
          Number.isFinite(coefficient) && coefficient > 0 ? Math.round(coefficient * 10_000) : null,
      };
    });
  };

  /**
   * Turn catalog models on or off for the whole deployment — the platform
   * admin's control over what the site offers.
   */
  setModelsEnabled = async (ids: string[], enabled: boolean): Promise<number> => {
    if (ids.length === 0) return 0;

    const now = new Date();
    const CHUNK = 200;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      await this.db
        .update(openrouterModelCatalog)
        .set({ enabled, updatedAt: now })
        .where(inArray(openrouterModelCatalog.id, chunk));
    }

    return ids.length;
  };

  listAsProviderModels = async (): Promise<AiProviderModelListItem[]> => {
    const rows = await this.db.select().from(openrouterModelCatalog);

    const mapped = rows.map((row) => {
      // AICO-180: `payload` is the raw OpenRouter model JSON. Drop every
      // cost-bearing field before spreading it into a client-visible response —
      // the marked-up `pricing` below is the only price a caller may see.
      const { pricing: _rawPricing, ...payload } = (row.payload ?? {}) as Record<string, unknown>;
      const isAuto = row.id === OPENROUTER_AUTO_MODEL_ID;
      return {
        ...payload,
        abilities: (row.abilities ?? {}) as ModelAbilities,
        contextWindowTokens: row.contextWindowTokens ?? undefined,
        description: row.description ?? undefined,
        displayName: isAuto ? OPENROUTER_AUTO_DISPLAY_NAME : (row.displayName ?? undefined),
        // The stored flag is authoritative: it is what the platform admin edits,
        // and the only thing deciding whether the site offers this model.
        // Per-user overrides still layer on top, from `ai_models`.
        enabled: row.enabled,
        id: row.id,
        pricing: (row.pricing ?? undefined) as Pricing | undefined,
        releasedAt: row.releasedAt ?? undefined,
        settings: (row.settings ?? undefined) as AiProviderModelListItem['settings'],
        source: AiModelSourceEnum.Remote,
        type: normalizeAiModelType(row.type),
      } as AiProviderModelListItem;
    });

    if (mapped.some((m) => m.id === OPENROUTER_AUTO_MODEL_ID)) {
      // Serve path must be self-healing: a catalog synced before the embedding
      // injection (or never re-synced) has no embedding rows, which leaves the
      // memory-embedding default disabled. Backfill the same cards
      // `replaceCatalog` injects at sync time.
      return ensureOpenRouterModels(mapped, [
        ...EMBEDDING_PROVIDER_CARDS,
        ...managedGenerationCatalogCards().map(toProviderCard),
      ]);
    }

    return [
      {
        abilities: {},
        contextWindowTokens: AUTO_CATALOG_CARD.contextWindowTokens,
        description: AUTO_CATALOG_CARD.description,
        displayName: OPENROUTER_AUTO_DISPLAY_NAME,
        enabled: true,
        id: OPENROUTER_AUTO_MODEL_ID,
        source: AiModelSourceEnum.Remote,
        type: 'chat',
      } as AiProviderModelListItem,
      ...ensureOpenRouterModels(mapped, [
        ...EMBEDDING_PROVIDER_CARDS,
        ...managedGenerationCatalogCards().map(toProviderCard),
      ]),
    ];
  };

  /**
   * Recompute and persist `enabled` flags from the current catalog rows
   * (latest 4 chat models per openai / anthropic / google, pinned chat ids,
   * plus all image/video/embedding models).
   *
   * Destructive: `enabled` is the platform admin's setting, so this discards
   * every choice they have made and returns the catalog to the curated
   * defaults. It is a deliberate "reset", never part of a sync.
   */
  reseedDefaultEnabledFlags = async (): Promise<number> => {
    const rows = await this.db
      .select({
        id: openrouterModelCatalog.id,
        releasedAt: openrouterModelCatalog.releasedAt,
        type: openrouterModelCatalog.type,
      })
      .from(openrouterModelCatalog);

    if (rows.length === 0) return 0;

    const defaultEnabled = computeDefaultEnabledOpenRouterModelIds(rows);
    const now = new Date();

    await this.db.transaction(async (tx) => {
      const enabledIds = [...defaultEnabled].filter((id) => rows.some((r) => r.id === id));
      const disabledIds = rows.map((r) => r.id).filter((id) => !defaultEnabled.has(id));

      if (enabledIds.length > 0) {
        await tx
          .update(openrouterModelCatalog)
          .set({ enabled: true, updatedAt: now })
          .where(inArray(openrouterModelCatalog.id, enabledIds));
      }
      if (disabledIds.length > 0) {
        const CHUNK = 200;
        for (let i = 0; i < disabledIds.length; i += CHUNK) {
          const chunk = disabledIds.slice(i, i + CHUNK);
          await tx
            .update(openrouterModelCatalog)
            .set({ enabled: false, updatedAt: now })
            .where(inArray(openrouterModelCatalog.id, chunk));
        }
      }
    });

    return defaultEnabled.size;
  };

  /**
   * Replace the catalog with a fresh OpenRouter snapshot.
   *
   * Always keeps product Auto. `enabled` is deliberately *not* refreshed for
   * rows that already exist — it is the platform admin's setting, and a sync
   * that recomputed it would silently revert their choices. New ids arrive
   * enabled, so a model added upstream reaches the site without an extra step.
   */
  replaceCatalog = async (params: {
    models: OpenRouterCatalogModelInput[];
    triggeredBy: string;
  }): Promise<OpenRouterCatalogSyncStatus> => {
    const now = new Date();
    const models = ensureOpenRouterModels(
      ensureOpenRouterAutoModel(params.models, AUTO_CATALOG_CARD),
      [...EMBEDDING_CATALOG_CARDS, ...managedGenerationCatalogCards()],
    );
    const incomingIds = models.map((m) => m.id);

    const existing = await this.db
      .select({ id: openrouterModelCatalog.id })
      .from(openrouterModelCatalog);
    const existingIds = new Set(existing.map((r) => r.id));

    const addedModelIds = incomingIds.filter(
      (id) => !existingIds.has(id) && id !== OPENROUTER_AUTO_MODEL_ID,
    );
    const removedModelIds = existing
      .filter((r) => !incomingIds.includes(r.id) && r.id !== OPENROUTER_AUTO_MODEL_ID)
      .map((r) => r.id);

    const rows: NewOpenrouterModelCatalog[] = models.map((model) => {
      const {
        abilities,
        contextWindowTokens,
        description,
        displayName,
        enabled: _ignoredEnabled,
        id,
        pricing,
        releasedAt,
        settings,
        type,
        ...rest
      } = model;

      const resolvedDisplayName =
        id === OPENROUTER_AUTO_MODEL_ID ? OPENROUTER_AUTO_DISPLAY_NAME : (displayName ?? null);

      return {
        abilities: abilities ?? {},
        contextWindowTokens: contextWindowTokens ?? null,
        description: description ?? null,
        displayName: resolvedDisplayName,
        // Only reaches the table on insert; the upsert below leaves `enabled`
        // alone so an existing row keeps whatever the admin set.
        enabled: true,
        id,
        payload: {
          ...rest,
          abilities,
          contextWindowTokens,
          description,
          displayName: resolvedDisplayName,
          id,
          pricing,
          releasedAt,
          settings,
          type,
        },
        pricing: pricing ?? null,
        releasedAt: releasedAt ? releasedAt.slice(0, 10) : null,
        settings: settings ?? {},
        syncedAt: now,
        type: normalizeAiModelType(type) || 'chat',
      };
    });

    await this.db.transaction(async (tx) => {
      if (incomingIds.length > 0) {
        // Delete rows that disappeared from OpenRouter (never drop Auto)
        const stale = removedModelIds;
        if (stale.length > 0) {
          await tx.delete(openrouterModelCatalog).where(inArray(openrouterModelCatalog.id, stale));
        }

        // Upsert in chunks to stay under parameter limits
        const CHUNK = 100;
        for (let i = 0; i < rows.length; i += CHUNK) {
          const chunk = rows.slice(i, i + CHUNK);
          await tx
            .insert(openrouterModelCatalog)
            .values(chunk)
            .onConflictDoUpdate({
              set: {
                abilities: sql`excluded.abilities`,
                contextWindowTokens: sql`excluded.context_window_tokens`,
                description: sql`excluded.description`,
                displayName: sql`excluded.display_name`,
                payload: sql`excluded.payload`,
                pricing: sql`excluded.pricing`,
                releasedAt: sql`excluded.released_at`,
                settings: sql`excluded.settings`,
                syncedAt: sql`excluded.synced_at`,
                type: sql`excluded.type`,
                updatedAt: now,
              },
              target: openrouterModelCatalog.id,
            });
        }
      } else {
        await tx.delete(openrouterModelCatalog);
      }

      await tx
        .insert(openrouterModelSyncState)
        .values({
          id: SYNC_STATE_ID,
          lastError: null,
          lastStatus: 'success',
          lastSyncedAt: now,
          lastTriggeredBy: params.triggeredBy,
          modelCount: rows.length,
        })
        .onConflictDoUpdate({
          set: {
            lastError: null,
            lastStatus: 'success',
            lastSyncedAt: now,
            lastTriggeredBy: params.triggeredBy,
            modelCount: rows.length,
            updatedAt: now,
          },
          target: openrouterModelSyncState.id,
        });

      await tx.insert(openrouterModelSyncRuns).values({
        addedModelIds,
        error: null,
        modelCount: rows.length,
        removedModelIds,
        status: 'success',
        syncedAt: now,
        triggeredBy: params.triggeredBy,
      });
    });

    return this.getSyncStatus();
  };

  markSyncError = async (params: {
    error: string;
    triggeredBy: string;
  }): Promise<OpenRouterCatalogSyncStatus> => {
    const now = new Date();
    const current = await this.getSyncStatus();
    const errorText = params.error.slice(0, 2000);
    await this.db.transaction(async (tx) => {
      await tx
        .insert(openrouterModelSyncState)
        .values({
          id: SYNC_STATE_ID,
          lastError: errorText,
          lastStatus: 'error',
          lastSyncedAt: current.lastSyncedAt ? new Date(current.lastSyncedAt) : null,
          lastTriggeredBy: params.triggeredBy,
          modelCount: current.modelCount,
        })
        .onConflictDoUpdate({
          set: {
            lastError: errorText,
            lastStatus: 'error',
            lastTriggeredBy: params.triggeredBy,
            updatedAt: now,
          },
          target: openrouterModelSyncState.id,
        });

      await tx.insert(openrouterModelSyncRuns).values({
        addedModelIds: [],
        error: errorText,
        modelCount: current.modelCount,
        removedModelIds: [],
        status: 'error',
        syncedAt: now,
        triggeredBy: params.triggeredBy,
      });
    });

    return this.getSyncStatus();
  };
}
