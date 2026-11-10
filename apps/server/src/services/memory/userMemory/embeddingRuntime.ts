import { DEFAULT_USER_MEMORY_EMBEDDING_MODEL_ITEM } from '@lobechat/const';
import { type LobeChatDatabase } from '@lobechat/database';

import { AicoBillingModel } from '@/database/models/aicoBilling';
import { getServerDefaultFilesConfig } from '@/server/globalConfig';
import { initEmbeddingRuntimeFromDB } from '@/server/modules/ModelRuntime';
import { resolvePreferredGenerationBilling } from '@/server/services/aico/generationBilling';

import { embedUserMemoryTexts, type UserMemoryEmbeddingRuntime } from './embedding';

/**
 * Resolves the billed embedding runtime and model used for user-memory vectors.
 */
export const getUserMemoryEmbeddingRuntime = async (serverDB: LobeChatDatabase, userId: string) => {
  const { provider, model: embeddingModel } =
    getServerDefaultFilesConfig().embeddingModel || DEFAULT_USER_MEMORY_EMBEDDING_MODEL_ITEM;
  const billingModel = new AicoBillingModel(serverDB);
  const billingContext = await resolvePreferredGenerationBilling(
    async (uid) => (await billingModel.getUserWallet(uid)) ?? null,
    userId,
  );
  const agentRuntime = await initEmbeddingRuntimeFromDB(serverDB, userId, provider, undefined, {
    billingContext,
    modelId: embeddingModel,
  });

  return { agentRuntime, embeddingModel };
};

/**
 * Builds a single-text embedder. Empty text resolves to `undefined`.
 */
export const createUserMemoryEmbedder = (
  agentRuntime: UserMemoryEmbeddingRuntime,
  embeddingModel: string,
  userId: string,
  source = 'lambda:userMemories.tool',
) => {
  return async (value?: string | null): Promise<number[] | undefined> => {
    if (!value || value.trim().length === 0) return undefined;

    const [embedding] = await embedUserMemoryTexts({
      input: [value],
      model: embeddingModel,
      runtime: agentRuntime,
      source,
      userId,
    });

    return embedding;
  };
};
