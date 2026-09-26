import { BRANDING_NAME } from './branding';
import { DEFAULT_MINI_MODEL } from './llm';
import { MANAGED_PROVIDER_IDS } from './managedProvider';

/** Pinned OpenRouter auto-router id (UI brands as `{BRANDING_NAME}/auto`, e.g. panachat/auto). */
export const OPENROUTER_AUTO_MODEL_ID = 'openrouter/auto';

/**
 * The product Auto router's storage id, under a provider-neutral name.
 *
 * Identical string to {@link OPENROUTER_AUTO_MODEL_ID} and deliberately so: the
 * id is written into agent configs and pinned as a catalog row, so it outlives
 * whichever upstream currently serves it. Prefer this alias in code that is not
 * specifically about OpenRouter.
 */
export const MANAGED_AUTO_MODEL_ID = OPENROUTER_AUTO_MODEL_ID;

const AUTO_MODEL_SUFFIX = 'auto';

/**
 * True for every spelling of the product Auto router.
 *
 * Accepts `openrouter/auto` (what is stored), `aico/auto` (the managed alias
 * provider), `{BRANDING_NAME}/auto` (what the UI displays, which a user can type
 * back into an API call), any other managed provider's `/auto`, and a bare
 * `auto`. Written permissively because the cost of missing one is a request
 * dispatched upstream as a literal model named "auto", which every provider
 * rejects.
 */
export const isManagedAutoModelId = (modelId: string | null | undefined): boolean => {
  const id = modelId?.trim().toLowerCase();
  if (!id) return false;
  if (id === AUTO_MODEL_SUFFIX) return true;

  const slash = id.lastIndexOf('/');
  if (slash < 0 || id.slice(slash + 1) !== AUTO_MODEL_SUFFIX) return false;

  const prefix = id.slice(0, slash);
  return (
    prefix === 'aico' ||
    prefix === BRANDING_NAME.trim().toLowerCase() ||
    (MANAGED_PROVIDER_IDS as readonly string[]).includes(prefix)
  );
};

/** Display name for the pinned auto router (product brand, not OpenRouter). */
export const OPENROUTER_AUTO_DISPLAY_NAME = `${BRANDING_NAME} Auto`;

/** OpenRouter id prefixes treated as default-enabled families (ChatGPT / Claude / Gemini). */
export const OPENROUTER_DEFAULT_ENABLED_FAMILIES = ['openai', 'anthropic', 'google'] as const;

export type OpenRouterDefaultEnabledFamily = (typeof OPENROUTER_DEFAULT_ENABLED_FAMILIES)[number];

/** How many newest chat models to enable per family by default. */
export const DEFAULT_ENABLED_MODELS_PER_FAMILY = 4;

/**
 * Chat models pinned on top of the newest-per-family curation, so widely used
 * models stay enabled even after newer generations push them out of the top 4
 * (e.g. `openai/gpt-4o`). Includes {@link DEFAULT_MINI_MODEL} — most system-agent
 * roles (topic naming, translation, prompt rewrite, ...) default to it, so it
 * must stay enabled or those roles show a disabled model out of the box.
 */
export const DEFAULT_ENABLED_OPENROUTER_PINNED_CHAT_MODEL_IDS = [
  'openai/gpt-4o',
  DEFAULT_MINI_MODEL,
] as const;

/**
 * Image Create defaults (OpenRouter Nano Banana family).
 * Catalog sync stores these as `type: 'image'` with `:image` suffix; chat-only
 * default selection never enables them unless we pin them here.
 */
export const DEFAULT_ENABLED_OPENROUTER_IMAGE_MODEL_IDS = [
  'gpt-image-2',
  'meta/muse-image',
  'google/gemini-3.1-flash-image-preview:image',
  'google/gemini-2.5-flash-image:image',
  'google/gemini-3-pro-image-preview:image',
] as const;

const IMAGE_MODEL_SUFFIX = ':image';

/**
 * Provider that serves the default image generator for the product Auto router.
 * Auto (`{BRANDING_NAME}/auto`) never resolves an image model on its own, so the
 * image-generation tool pins this one instead of walking the catalog and burning
 * credits on whichever generator happens to sort first.
 */
export const DEFAULT_AUTO_IMAGE_MODEL_PROVIDER = 'openrouter';

/**
 * Default image generators used when the chat model is the Auto router, in
 * preference order. GPT Image 2 (medium quality via its schema default) is
 * served by CheapVibeCode; OpenRouter does not offer that id, so a deployment
 * on OpenRouter falls through to Muse.
 */
export const DEFAULT_AUTO_IMAGE_MODEL_IDS = ['gpt-image-2', 'meta/muse-image'] as const;

export const DEFAULT_AUTO_IMAGE_MODEL_ID = DEFAULT_AUTO_IMAGE_MODEL_IDS[0];

const matchesImageModelId = (id: string, defaultId: string) =>
  id === defaultId || id === `${defaultId}${IMAGE_MODEL_SUFFIX}`;

/**
 * Catalog sync stores chat models with image output under an `:image` suffix, so
 * a pinned default can legitimately show up under either id.
 */
export const isDefaultAutoImageModelId = (id: string): boolean =>
  DEFAULT_AUTO_IMAGE_MODEL_IDS.some((defaultId) => matchesImageModelId(id, defaultId));

/** The most preferred default image model present in `candidates`. */
export const pickDefaultAutoImageModel = <T>(
  candidates: T[],
  getId: (candidate: T) => string,
): T | undefined => {
  for (const defaultId of DEFAULT_AUTO_IMAGE_MODEL_IDS) {
    const match = candidates.find((candidate) => matchesImageModelId(getId(candidate), defaultId));
    if (match) return match;
  }
  return undefined;
};

export type OpenRouterDefaultModelCandidate = {
  id: string;
  releasedAt?: string | null;
  type?: string | null;
};

const familyOf = (id: string): OpenRouterDefaultEnabledFamily | null => {
  const slash = id.indexOf('/');
  if (slash <= 0) return null;
  const prefix = id.slice(0, slash);
  return (OPENROUTER_DEFAULT_ENABLED_FAMILIES as readonly string[]).includes(prefix)
    ? (prefix as OpenRouterDefaultEnabledFamily)
    : null;
};

const isChatType = (type?: string | null): boolean => {
  const normalized = (type || 'chat').toLowerCase();
  return normalized === 'chat';
};

const isImageOrVideoType = (type?: string | null): boolean => {
  const normalized = (type || '').toLowerCase();
  return normalized === 'image' || normalized === 'video';
};

const isEmbeddingType = (type?: string | null): boolean =>
  (type || '').toLowerCase() === 'embedding';

/**
 * Returns the set of OpenRouter model ids that should be enabled by default:
 * always includes {@link OPENROUTER_AUTO_MODEL_ID}, plus the
 * {@link DEFAULT_ENABLED_MODELS_PER_FAMILY} newest chat models from each of
 * openai / anthropic / google (by `releasedAt` desc; missing dates sort last),
 * pinned chat models ({@link DEFAULT_ENABLED_OPENROUTER_PINNED_CHAT_MODEL_IDS}),
 * every chat model when the catalog has no `vendor/`-prefixed families at all
 * (a pre-curated gateway list such as CheapVibeCode's, where the per-family trim
 * has nothing to rank on),
 * every catalog `image` / `video` generator (Create pickers only list enabled
 * models) and every catalog `embedding` model (knowledge / memory pickers only
 * list enabled models), plus Nano Banana Image-tab pins and `:image` clones of
 * default chat ids when those rows exist.
 */
export const computeDefaultEnabledOpenRouterModelIds = (
  models: OpenRouterDefaultModelCandidate[],
  perFamily: number = DEFAULT_ENABLED_MODELS_PER_FAMILY,
): Set<string> => {
  const buckets = new Map<OpenRouterDefaultEnabledFamily, OpenRouterDefaultModelCandidate[]>();
  const catalogIds = new Set(models.map((model) => model.id));

  for (const family of OPENROUTER_DEFAULT_ENABLED_FAMILIES) {
    buckets.set(family, []);
  }

  for (const model of models) {
    if (!isChatType(model.type)) continue;
    const family = familyOf(model.id);
    if (!family) continue;
    buckets.get(family)!.push(model);
  }

  // Always pin product Auto — even if the upstream snapshot omitted it.
  const enabled = new Set<string>([OPENROUTER_AUTO_MODEL_ID]);

  // A catalog with no `vendor/` prefixes at all is a pre-curated flagship list
  // rather than a long tail — CheapVibeCode ships ~36 bare ids (`claude-opus-5`,
  // `gpt-6-astra`) and publishes no release dates. Both inputs the
  // newest-N-per-family trim ranks on are therefore absent, and running it
  // anyway enables nothing but the pins, which is what a user sees as an empty
  // model picker. Upstream already did the curating here, so take all of it.
  // OpenRouter keeps the trim untouched, so a rollback restores today's list.
  if ([...buckets.values()].every((bucket) => bucket.length === 0)) {
    for (const model of models) {
      if (isChatType(model.type)) enabled.add(model.id);
    }
  }

  for (const family of OPENROUTER_DEFAULT_ENABLED_FAMILIES) {
    const ranked = buckets.get(family)!.toSorted((a, b) => {
      const aDate = a.releasedAt?.slice(0, 10) || '';
      const bDate = b.releasedAt?.slice(0, 10) || '';
      if (aDate && bDate && aDate !== bDate) return bDate.localeCompare(aDate);
      if (aDate && !bDate) return -1;
      if (!aDate && bDate) return 1;
      return a.id.localeCompare(b.id);
    });

    for (const model of ranked.slice(0, perFamily)) {
      enabled.add(model.id);
    }
  }

  // Pin widely used chat models that the newest-per-family curation would drop.
  for (const pinnedId of DEFAULT_ENABLED_OPENROUTER_PINNED_CHAT_MODEL_IDS) {
    if (catalogIds.has(pinnedId)) enabled.add(pinnedId);
  }

  // Pin Image Create Nano Banana defaults when the catalog has them.
  for (const imageId of DEFAULT_ENABLED_OPENROUTER_IMAGE_MODEL_IDS) {
    if (catalogIds.has(imageId)) enabled.add(imageId);
  }

  // Enable synthesized `:image` siblings for every default-enabled chat card.
  for (const id of enabled) {
    if (id.endsWith(IMAGE_MODEL_SUFFIX)) continue;
    const imageId = `${id}${IMAGE_MODEL_SUFFIX}`;
    if (catalogIds.has(imageId)) enabled.add(imageId);
  }

  // Image / Video Create list enabled models only. Chat stays curated (hundreds
  // of cards); enable every catalog generator so Flux, Veo, etc. appear.
  // Same for embeddings: knowledge / memory pickers only list enabled models,
  // so enable every catalog embedding (e.g. text-embedding-3-small/large).
  for (const model of models) {
    if (isImageOrVideoType(model.type) || isEmbeddingType(model.type)) enabled.add(model.id);
  }

  return enabled;
};

/**
 * Prefer product Auto, then newest OpenAI / Anthropic / Google from the default-enabled set.
 */
export const pickPreferredDefaultOpenRouterModelId = (
  enabledIds: Iterable<string>,
): string | null => {
  const ids = [...enabledIds];
  if (ids.includes(OPENROUTER_AUTO_MODEL_ID)) return OPENROUTER_AUTO_MODEL_ID;
  for (const family of OPENROUTER_DEFAULT_ENABLED_FAMILIES) {
    const prefix = `${family}/`;
    const match = ids.find((id) => id.startsWith(prefix));
    if (match) return match;
  }
  return null;
};

/**
 * Ensure specific catalog cards exist by id (inject any card whose id is missing
 * from the snapshot, preserving the rest). Used for cards the live OpenRouter
 * `/models` listing omits — the product Auto router, and embedding models (the
 * OpenRouter embeddings API isn't covered by that listing endpoint).
 */
export const ensureOpenRouterModels = <T extends { id: string }>(
  models: T[],
  extraCards: T[],
): T[] => {
  const existingIds = new Set(models.map((m) => m.id));
  const missing = extraCards.filter((card) => !existingIds.has(card.id));
  return missing.length > 0 ? [...missing, ...models] : models;
};

/** Ensure the Auto router card exists in a catalog snapshot (inject if missing). */
export const ensureOpenRouterAutoModel = <T extends { id: string }>(
  models: T[],
  autoCard: T,
): T[] => ensureOpenRouterModels(models, [autoCard]);
