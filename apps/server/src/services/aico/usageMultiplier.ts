import type { ModelPricingContext } from '@lobechat/model-runtime';

import { AicoBillingModel } from '@/database/models/aicoBilling';
import type { LobeChatDatabase } from '@/database/type';

const CACHE_TTL_MS = 60_000;

let cached: { bp: number; expiresAt: number } | null = null;

/** Test seam: forget the cached multiplier so the next read hits the DB. */
export const resetUsageMultiplierCache = () => {
  cached = null;
};

/**
 * The platform usage multiplier (AICO-180), cached in-process. It is a single
 * global row, so a short TTL keeps a hot chat path from adding a query per
 * request while still picking a super-admin change up within a minute.
 */
export const getCachedUsageMultiplierBp = async (db: LobeChatDatabase): Promise<number> => {
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.bp;

  const bp = await new AicoBillingModel(db).getUsageMultiplierBp();
  cached = { bp, expiresAt: now + CACHE_TTL_MS };
  return bp;
};

/**
 * Pricing context for managed (resold) traffic. Carrying the multiplier here is
 * what makes the cost attached to a chat/image/video response the billed
 * figure — the raw upstream rate never leaves the server.
 */
export const resolveManagedPricingContext = async (
  db: LobeChatDatabase,
): Promise<ModelPricingContext> => ({
  costMultiplierBp: await getCachedUsageMultiplierBp(db),
  plan: 'aico',
  scope: 'personal',
});
