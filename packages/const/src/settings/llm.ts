import { DEFAULT_PROVIDER, DEFAULT_SUB_AGENT_MODEL } from '@lobechat/business-const';
import type { LobeAgentAgencyConfig } from '@lobechat/types';

export { DEFAULT_MINI_MODEL, DEFAULT_MODEL } from '@lobechat/business-const';

/** OpenRouter SKU (matches the catalog's `openai/`-namespaced chat model ids). */
export const DEFAULT_EMBEDDING_MODEL = 'google/gemini-embedding-2';

/**
 * Default model for sub-agents spawned via `lobe-agent.callSubAgent` (per
 * managed gateway, see `@lobechat/business-const`). Sub-agents run on a
 * lightweight model by default instead of inheriting the parent agent's main
 * model. Overridable per agent via `agencyConfig.subagent`.
 *
 * Paired with `DEFAULT_PROVIDER` rather than a dedicated sub-agent provider, so
 * a build that swaps `@lobechat/business-const` moves the sub-agent along with
 * the main model instead of leaving it pointed at a provider it doesn't serve.
 */
export { DEFAULT_SUB_AGENT_MODEL } from '@lobechat/business-const';

/**
 * Resolve the model a sub-agent runs on from the spawning agent's
 * `agencyConfig.subagent`, falling back to the global default.
 *
 * Model and provider resolve as a pair: a config carrying a model but no
 * provider would otherwise mix a custom model id with the default provider.
 */
export const resolveSubAgentModel = (
  subagent: LobeAgentAgencyConfig['subagent'],
): { model: string; provider: string } =>
  subagent?.model
    ? { model: subagent.model, provider: subagent.provider || DEFAULT_PROVIDER }
    : { model: DEFAULT_SUB_AGENT_MODEL, provider: DEFAULT_PROVIDER };

export const DEFAULT_RERANK_MODEL = 'rerank-english-v3.0';
export const DEFAULT_RERANK_PROVIDER = 'cohere';
export const DEFAULT_RERANK_QUERY_MODE = 'full_text';
