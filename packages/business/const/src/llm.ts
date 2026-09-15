import { MANAGED_PROVIDER_ID, type ManagedProviderId } from './managedProvider';

/**
 * Default embedding provider.
 *
 * Deliberately pinned to OpenRouter even when the managed chat provider is
 * something else: CheapVibeCode publishes no embeddings route (the Phase 0 probe
 * found `/v1/embeddings` absent), so knowledge bases and memory would lose their
 * embedder the moment the switch flipped. Revisit only when the active managed
 * provider actually serves embeddings.
 */
export const DEFAULT_EMBEDDING_PROVIDER = 'openrouter';

/**
 * Default chat model — product Auto router (`openrouter/auto` storage id).
 *
 * The string is frozen at its original OpenRouter spelling regardless of which
 * managed provider is live: it is written into every agent config and pinned as
 * a catalog row, so changing it would orphan existing agents for no gain. The UI
 * brands it as `{BRANDING_NAME}/auto` (e.g. panachat/auto) and the server
 * resolves it to a concrete upstream model. Never use a direct openai/* SKU as
 * the product default.
 */
export const DEFAULT_MODEL = 'openrouter/auto';

/**
 * Managed provider surface (UI shows BRANDING_NAME, not the upstream name).
 *
 * Follows `AICO_MANAGED_PROVIDER`, which makes the cutover an env change. Note
 * this resolves to the default inside a browser bundle — `MANAGED_PROVIDER_ID`
 * has no `NEXT_PUBLIC_` twin on purpose — so a client-created agent config can
 * carry `openrouter` while the server is on another managed provider. That is
 * harmless because `AicoManagedPolicy.resolveRuntimeProvider` maps every managed
 * provider id onto the active one.
 */
export const DEFAULT_PROVIDER: ManagedProviderId = MANAGED_PROVIDER_ID;

/**
 * Lightweight helpers / system agents (topic naming, translation, prompt
 * rewrite, ...). Per-provider because the id is an upstream SKU, not a product
 * id: OpenRouter's `openai/gpt-4o-mini` does not exist on CheapVibeCode, whose
 * cheapest tool-capable model is `glm-5.3-flash`. Never a direct-vendor SKU.
 */
const MINI_MODEL_BY_PROVIDER: Record<ManagedProviderId, string> = {
  cheapvibecode: 'glm-5.3-flash',
  openrouter: 'openai/gpt-4o-mini',
};

export const DEFAULT_MINI_MODEL = MINI_MODEL_BY_PROVIDER[MANAGED_PROVIDER_ID];
export const DEFAULT_MINI_PROVIDER: ManagedProviderId = MANAGED_PROVIDER_ID;

/** Onboarding / first-agent defaults must stay on the managed surface. */
export const DEFAULT_ONBOARDING_MODEL = DEFAULT_MODEL;
export const DEFAULT_ONBOARDING_PROVIDER: ManagedProviderId = MANAGED_PROVIDER_ID;
