import { toLiveManagedModelId } from '@lobechat/business-const';

import { AicoBillingModel } from '@/database/models/aicoBilling';
import { type LobeChatDatabase } from '@/database/type';
import { initModelRuntimeFromDB } from '@/server/modules/ModelRuntime';

import { type AicoBillingContext } from './billingContext';
import { resolvePreferredGenerationBilling } from './generationBilling';
import { AicoManagedPolicy } from './managedPolicy';

/**
 * Billing context for a server-side call that has no browser request to carry
 * one: the user's stored preference (org member budget or personal wallet).
 */
export const resolveServerBillingContext = (
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
 * Model id a server caller must both authorize and send. A managed gateway only
 * knows its own ids, so another gateway's default (kept in saved settings) is
 * mapped onto the live one; BYOK ids pass through unchanged.
 */
export const toServerCallModelId = (provider: string, model: string): string =>
  AicoManagedPolicy.isManagedProvider(provider) ? toLiveManagedModelId(model) : model;

/**
 * `initModelRuntimeFromDB` for server-side callers (system agents, task
 * lifecycle, agent signals, tool runtimes).
 *
 * A managed provider refuses a call without an explicit billing context and
 * model (`BILLING_CONTEXT_REQUIRED` / `MODEL_ID_REQUIRED`), so for those this
 * bills the user's preferred source and authorizes `model`. Send the same id in
 * the request (see `toServerCallModelId`). BYOK providers are unchanged.
 */
export const initServerModelRuntime = async (params: {
  db: LobeChatDatabase;
  model: string;
  provider: string;
  userId: string;
  workspaceId?: string;
}) => {
  const { db, model, provider, userId, workspaceId } = params;

  if (!AicoManagedPolicy.isManagedProvider(provider)) {
    return initModelRuntimeFromDB(db, userId, provider, workspaceId);
  }

  return initModelRuntimeFromDB(db, userId, provider, workspaceId, {
    billingContext: await resolveServerBillingContext(db, userId),
    modelId: toServerCallModelId(provider, model),
  });
};
