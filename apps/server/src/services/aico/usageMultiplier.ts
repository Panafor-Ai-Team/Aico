import { MANAGED_PROVIDER_ID } from '@lobechat/business-const';
import type { ModelPricingContext } from '@lobechat/model-runtime';

import { AicoBillingModel } from '@/database/models/aicoBilling';
import type { LobeChatDatabase } from '@/database/type';

const CACHE_TTL_MS = 60_000;

/** Keyed by managed provider id — the multiplier is per-provider (AICO-186). */
const cached = new Map<string, { bp: number; expiresAt: number }>();

/** Test seam: forget the cached multipliers so the next read hits the DB. */
export const resetUsageMultiplierCache = () => {
  cached.clear();
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

/**
 * Pricing context for managed (resold) traffic. Carrying the multiplier here is
 * what makes the cost attached to a chat/image/video response the billed
 * figure — the raw upstream rate never leaves the server.
 *
 * Per-model coefficients are not adjusted here: they come from the upstream
 * catalog, and the model picker applies the same single markup in
 * `withUsageMultiplier`.
 */
export const resolveManagedPricingContext = async (
  db: LobeChatDatabase,
  providerId: string = MANAGED_PROVIDER_ID,
): Promise<ModelPricingContext> => ({
  costMultiplierBp: await getCachedUsageMultiplierBp(db, providerId),
  plan: 'aico',
  scope: 'personal',
});
