import { MANAGED_PROVIDER_ID, OPENROUTER_AUTO_MODEL_ID } from '@lobechat/business-const';
import { fetchOpenRouterModels } from '@lobechat/model-runtime';
import type { ChatModelCard } from '@lobechat/types';
import type { ModelAbilities } from 'model-bank';

import {
  type OpenRouterCatalogSyncRun,
  type OpenRouterCatalogSyncStatus,
  OpenRouterModelCatalogModel,
} from '@/database/models/openrouterModelCatalog';
import type { LobeChatDatabase } from '@/database/type';
import { aicoEnv } from '@/envs/aico';
import { getManagedProviderClient } from '@/server/services/managedProvider';

const toAbilities = (model: ChatModelCard): ModelAbilities => {
  const abilities: ModelAbilities = {};
  if (model.files) abilities.files = true;
  if (model.functionCall) abilities.functionCall = true;
  if (model.imageOutput) abilities.imageOutput = true;
  if (model.reasoning) abilities.reasoning = true;
  if (model.search) abilities.search = true;
  if (model.video) abilities.video = true;
  if (model.vision) abilities.vision = true;
  return abilities;
};

/**
 * The live catalog of whichever gateway `AICO_MANAGED_PROVIDER` makes active.
 *
 * OpenRouter's `/models` is public, so it is fetched directly. Every other
 * managed provider goes through the provider client, which for CheapVibeCode
 * means the control-plane proxy — listing models there needs the primary
 * credential, and that credential never reaches this process.
 *
 * A provider that cannot list models throws rather than returning `[]`: an empty
 * snapshot would be recorded as a successful sync of nothing, and the served
 * catalog would silently fall back to the static model-bank file.
 */
const fetchManagedCatalog = async (): Promise<ChatModelCard[]> => {
  if (MANAGED_PROVIDER_ID === 'openrouter') return fetchOpenRouterModels();

  const client = getManagedProviderClient();
  if (!client.listModels) {
    throw new Error(`Managed provider ${client.providerId} cannot list models`);
  }
  return client.listModels();
};

const isUpstreamChat = (model: { id: string; type?: string | null }) =>
  (model.type ?? 'chat') === 'chat' && model.id !== OPENROUTER_AUTO_MODEL_ID;

/**
 * Why a fetched catalog should not replace the stored one, or null when it may.
 *
 * `replaceCatalog` deletes every row missing from the response, and the usage
 * ledger cannot price a model without catalog pricing. A truncated or
 * price-less response from a flaky upstream would therefore leave models
 * unpriced until the next sync — so it is refused and the previous catalog,
 * with its last known coefficients, keeps serving.
 */
export const catalogFetchRejection = ({
  existingChatCount,
  fetched,
  requirePricing,
}: {
  existingChatCount: number;
  fetched: ChatModelCard[];
  requirePricing: boolean;
}): string | null => {
  const chat = fetched.filter(isUpstreamChat);

  if (existingChatCount >= 4 && chat.length * 2 < existingChatCount) {
    return `Refused catalog with ${chat.length} chat models (had ${existingChatCount}); keeping the previous catalog`;
  }
  if (requirePricing && chat.length > 0 && !chat.some((model) => model.pricing)) {
    return 'Refused catalog with no priced chat models; keeping the previous catalog';
  }
  return null;
};

export class OpenRouterModelCatalogSyncService {
  private catalog: OpenRouterModelCatalogModel;

  constructor(db: LobeChatDatabase) {
    this.catalog = new OpenRouterModelCatalogModel(db);
  }

  getStatus = async (): Promise<OpenRouterCatalogSyncStatus> => {
    return this.catalog.getSyncStatus();
  };

  listHistory = async (limit = 20): Promise<OpenRouterCatalogSyncRun[]> => {
    return this.catalog.listSyncRuns(limit);
  };

  /** Per-model published coefficients for the admin model table. */
  listCatalogCoefficients = async () => {
    return this.catalog.listCoefficients(
      MANAGED_PROVIDER_ID === 'cheapvibecode'
        ? { tokensPerUsd: aicoEnv.AICO_CVC_TOKENS_PER_USD }
        : undefined,
    );
  };

  /** Choose which catalog models the site offers. */
  setModelsEnabled = async (ids: string[], enabled: boolean) => {
    return this.catalog.setModelsEnabled(ids, enabled);
  };

  /**
   * If the catalog is empty (first setup), pull OpenRouter once.
   * Returns whether a sync was attempted.
   */
  ensureInitialCatalog = async (): Promise<{
    synced: boolean;
    status: OpenRouterCatalogSyncStatus;
  }> => {
    const count = await this.catalog.count();
    if (count > 0) {
      return { status: await this.catalog.getSyncStatus(), synced: false };
    }
    const status = await this.sync('bootstrap');
    return { status, synced: true };
  };

  /**
   * Fetch the live OpenRouter catalog and persist it for the managed Aico provider.
   * @param triggeredBy `cron` | `bootstrap` | `manual:<userId>`
   */
  sync = async (triggeredBy: string): Promise<OpenRouterCatalogSyncStatus> => {
    try {
      const models = await fetchManagedCatalog();

      const existing = await this.catalog.listPricingRows();
      const rejection = catalogFetchRejection({
        existingChatCount: existing.filter(isUpstreamChat).length,
        fetched: models,
        // OpenRouter rows are priced in USD per token and may legitimately lack
        // pricing; every other gateway derives pricing from a published coefficient.
        requirePricing: MANAGED_PROVIDER_ID !== 'openrouter',
      });
      if (rejection) return this.catalog.markSyncError({ error: rejection, triggeredBy });

      return await this.catalog.replaceCatalog({
        models: models.map((model) => ({
          abilities: toAbilities(model),
          contextWindowTokens: model.contextWindowTokens,
          description: model.description,
          displayName: model.displayName,
          id: model.id,
          // Kept in the payload: the usage ledger bounds a hold by the model's own output cap.
          maxOutput: model.maxOutput,
          parameters: model.parameters,
          pricing: model.pricing,
          releasedAt: model.releasedAt,
          settings: model.settings,
          type: model.type ?? 'chat',
        })),
        triggeredBy,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.catalog.markSyncError({ error: message, triggeredBy });
    }
  };
}
