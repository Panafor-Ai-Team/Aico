import { AicoBillingModel } from '@/database/models/aicoBilling';
import { type LobeChatDatabase } from '@/database/type';
import { initEmbeddingRuntimeFromDB, initModelRuntimeFromDB } from '@/server/modules/ModelRuntime';

import { type AicoBillingContext } from './billingContext';
import { resolvePreferredGenerationBilling } from './generationBilling';
import { AicoManagedPolicy, AicoManagedPolicyError } from './managedPolicy';

/**
 * Policy / ledger refusals meaning "this subject cannot pay right now". Memory
 * work hitting one of these is deferred, not failed: the topic stays eligible
 * and is processed on the first run after the wallet or budget is funded.
 */
const FUNDS_ERROR_CODES = new Set([
  'MANAGED_KEY_UNAVAILABLE',
  'MEMBER_BUDGET_INACTIVE',
  'MEMBER_BUDGET_NOT_ALLOCATED',
  'MEMBER_BUDGET_RENEWAL_BLOCKED',
  'MEMBER_BUDGET_UNFUNDED',
  'PERSONAL_FUNDS_UNAVAILABLE',
  'PERSONAL_WALLET_INACTIVE',
]);

export const isMemoryFundsError = (error: unknown): error is AicoManagedPolicyError =>
  error instanceof AicoManagedPolicyError && FUNDS_ERROR_CODES.has(error.code.split(':')[0]);

/** First funds refusal among per-layer extractor outputs, which swallow their errors. */
export const findMemoryFundsError = (
  outputs: Record<string, { error?: unknown } | undefined> | undefined,
): AicoManagedPolicyError | undefined => {
  for (const output of Object.values(outputs ?? {})) {
    if (isMemoryFundsError(output?.error)) return output.error;
  }
  return undefined;
};

export const isManagedMemoryProvider = (provider?: string): boolean =>
  !!provider && AicoManagedPolicy.isManagedProvider(provider.toLowerCase());

export const resolveMemoryBillingContext = (
  db: LobeChatDatabase,
  userId: string,
): Promise<AicoBillingContext> => {
  const billingModel = new AicoBillingModel(db);
  return resolvePreferredGenerationBilling(
    async (uid) => (await billingModel.getUserWallet(uid)) ?? null,
    userId,
  );
};

/**
 * Managed runtime for a background memory agent, metered against the user's
 * preferred billing source (personal wallet or org member budget).
 */
export const initBilledMemoryRuntime = (params: {
  billingContext: AicoBillingContext;
  db: LobeChatDatabase;
  kind: 'embedding' | 'generation';
  modelId: string;
  provider: string;
  userId: string;
  workspaceId?: string;
}) => {
  const init = params.kind === 'embedding' ? initEmbeddingRuntimeFromDB : initModelRuntimeFromDB;
  return init(params.db, params.userId, params.provider, params.workspaceId, {
    billingContext: params.billingContext,
    modelId: params.modelId,
  });
};
