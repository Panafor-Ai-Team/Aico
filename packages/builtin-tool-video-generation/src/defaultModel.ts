/**
 * Managed providers Create → Video lists in Aico mode (wallet-backed slots).
 * CheapVibeCode's generators stay behind the `openrouter` slot in production.
 */
export const VIDEO_GENERATION_PROVIDERS = ['aico', 'openrouter'] as const;

/** Provider preferred when the caller does not name one. */
export const DEFAULT_VIDEO_MODEL_PROVIDER = 'openrouter';

/**
 * Default video generators for chat, in preference order: Grok Imagine Video
 * (CheapVibeCode gateway), then Create → Video's Seedance default.
 */
export const DEFAULT_VIDEO_MODEL_IDS = ['grok-imagine-video', 'dreamina-seedance-2-0-260128'];

export const isVideoGenerationProvider = (providerId: string) =>
  (VIDEO_GENERATION_PROVIDERS as readonly string[]).includes(providerId);

/**
 * True when `id` names the same generator as `target`, including vendor-prefixed
 * OpenRouter forms (`x-ai/grok-imagine-video` ↔ `grok-imagine-video`).
 */
export const matchesVideoModelId = (id: string, target: string): boolean => {
  if (!id || !target) return false;
  if (id === target) return true;
  return id.endsWith(`/${target}`) || target.endsWith(`/${id}`);
};

/** The most preferred default video model present in `candidates`. */
export const pickDefaultVideoModel = <T>(
  candidates: T[],
  getId: (candidate: T) => string,
): T | undefined => {
  for (const defaultId of DEFAULT_VIDEO_MODEL_IDS) {
    const match = candidates.find((candidate) => matchesVideoModelId(getId(candidate), defaultId));
    if (match) return match;
  }
  return undefined;
};

/** Exact id first, then vendor-prefix aliases. */
export const findVideoModelByRequestedId = <T>(
  candidates: T[],
  getId: (candidate: T) => string,
  requestedId: string,
): T | undefined =>
  candidates.find((candidate) => getId(candidate) === requestedId) ??
  candidates.find((candidate) => matchesVideoModelId(getId(candidate), requestedId));
