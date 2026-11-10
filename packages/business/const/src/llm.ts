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

/**
 * Default model for sub-agents spawned via `lobe-agent.callSubAgent`. Per
 * provider for the same reason as the mini model: the id is an upstream SKU.
 */
const SUB_AGENT_MODEL_BY_PROVIDER: Record<ManagedProviderId, string> = {
  cheapvibecode: 'deepseek-v4-flash',
  openrouter: 'deepseek/deepseek-chat-v3.1',
};

export const DEFAULT_SUB_AGENT_MODEL = SUB_AGENT_MODEL_BY_PROVIDER[MANAGED_PROVIDER_ID];

const PER_PROVIDER_DEFAULT_MODELS = [MINI_MODEL_BY_PROVIDER, SUB_AGENT_MODEL_BY_PROVIDER];

/**
 * Map another managed gateway's default model id onto the live gateway's.
 *
 * `MANAGED_PROVIDER_ID` has no `NEXT_PUBLIC_` twin, so a browser bundle always
 * resolves the defaults above as OpenRouter's (`openai/gpt-4o-mini`, …), and
 * users' saved settings keep whichever id was current when they saved. Sent to
 * CheapVibeCode as-is, those ids do not exist. Server entry points pass every
 * managed model id through here; any other id is returned unchanged.
 */
export const toLiveManagedModelId = (
  modelId: string,
  live: ManagedProviderId = MANAGED_PROVIDER_ID,
): string => {
  for (const table of PER_PROVIDER_DEFAULT_MODELS) {
    const foreign = Object.entries(table).some(
      ([gateway, id]) => gateway !== live && id === modelId,
    );
    if (foreign) return table[live];
  }
  return modelId;
};

/** Onboarding / first-agent defaults must stay on the managed surface. */
export const DEFAULT_ONBOARDING_MODEL = DEFAULT_MODEL;
export const DEFAULT_ONBOARDING_PROVIDER: ManagedProviderId = MANAGED_PROVIDER_ID;
