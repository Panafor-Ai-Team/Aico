import { MANAGED_PROVIDER_ID } from '@lobechat/business-const';
import type { ModelPricingContext } from '@lobechat/model-runtime';

import { AicoBillingModel } from '@/database/models/aicoBilling';
import type { LobeChatDatabase } from '@/database/type';

const CACHE_TTL_MS = 60_000;

/** Keyed by managed provider id — the multiplier is per-provider (AICO-186). */
const cached = new Map<string, { bp: number; expiresAt: number }>();

const modelOverridesCached = new Map<
  string,
  { expiresAt: number; overrides: Record<string, number> }
>();

/** Test seam: forget the cached multipliers so the next read hits the DB. */
export const resetUsageMultiplierCache = () => {
  cached.clear();
  modelOverridesCached.clear();
};

/**
 * The platform usage multiplier (AICO-180) for a managed provider, cached
 * in-process. It is one row per provider, so a short TTL keeps a hot chat path
 * from adding a query per request while still picking a super-admin change up
 * within a minute.
 */
export const getCachedUsageMultiplierBp = async (
  db: LobeChatDatabase,
  providerId: string = MANAGED_PROVIDER_ID,
): Promise<number> => {
  const now = Date.now();
  const hit = cached.get(providerId);
  if (hit && hit.expiresAt > now) return hit.bp;

  const bp = await new AicoBillingModel(db).getUsageMultiplierBp(providerId);
  cached.set(providerId, { bp, expiresAt: now + CACHE_TTL_MS });
  return bp;
};

/** Per-model coefficient corrections (AICO-187), cached on the same TTL. */
export const getCachedModelMultiplierOverrides = async (
  db: LobeChatDatabase,
  providerId: string = MANAGED_PROVIDER_ID,
): Promise<Record<string, number>> => {
  const now = Date.now();
  const hit = modelOverridesCached.get(providerId);
  if (hit && hit.expiresAt > now) return hit.overrides;

  const overrides = await new AicoBillingModel(db).getModelMultiplierOverrideMap(providerId);
  modelOverridesCached.set(providerId, { expiresAt: now + CACHE_TTL_MS, overrides });
  return overrides;
};

/**
 * Pricing context for managed (resold) traffic. Carrying the multiplier here is
 * what makes the cost attached to a chat/image/video response the billed
 * figure — the raw upstream rate never leaves the server.
 *
 * `modelCostMultiplierBp` carries the per-model corrections so the per-message
 * cost agrees with the price shown in the model picker, which applies the same
 * pair in `withUsageMultiplier`.
 */
export const resolveManagedPricingContext = async (
  db: LobeChatDatabase,
  providerId: string = MANAGED_PROVIDER_ID,
): Promise<ModelPricingContext> => ({
  costMultiplierBp: await getCachedUsageMultiplierBp(db, providerId),
  modelCostMultiplierBp: await getCachedModelMultiplierOverrides(db, providerId),
  plan: 'aico',
  scope: 'personal',
});
