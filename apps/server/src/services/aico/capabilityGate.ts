import { TRPCError } from '@trpc/server';

import { getServerFeatureFlagsStateFromRuntimeConfig } from '@/server/featureFlags';

/**
 * Aico capability gate: upstream features that ship OFF until product sign-off.
 *
 * Each capability is an operator feature flag (`FEATURE_FLAGS` env or runtime config, see
 * `packages/app-config/src/featureFlags/schema.ts`), resolved per user. The upstream Labs
 * toggles for these features are client-only, so every server entry point that can start
 * the feature — routers, tool manifests, tool execution, background loops — checks here.
 */
export type AicoCapability = 'expertise' | 'goals' | 'projects';

const STATE_KEY = {
  expertise: 'enableExpertise',
  goals: 'enableGoals',
  projects: 'enableProjects',
} as const satisfies Record<AicoCapability, string>;

export const CAPABILITY_DISABLED_MESSAGE = (capability: AicoCapability) =>
  `The ${capability} feature is not enabled`;

/** `true` only when the operator enabled `capability` for `userId`; fails closed. */
export const isCapabilityEnabled = async (
  userId: string | null | undefined,
  capability: AicoCapability,
): Promise<boolean> => {
  if (!userId) return false;
  try {
    const flags = await getServerFeatureFlagsStateFromRuntimeConfig(userId);
    return flags[STATE_KEY[capability]] === true;
  } catch {
    return false;
  }
};

/** Throws `FORBIDDEN` unless `capability` is enabled for `userId`. */
export const assertCapability = async (
  userId: string | null | undefined,
  capability: AicoCapability,
): Promise<void> => {
  if (await isCapabilityEnabled(userId, capability)) return;

  throw new TRPCError({ code: 'FORBIDDEN', message: CAPABILITY_DISABLED_MESSAGE(capability) });
};
