import type { ChatStreamPayload } from '../../types/chat';

/**
 * CheapVibeCode has no `auto` endpoint, so the product Auto router is
 * synthesized here: a request for Auto is rewritten to a concrete model id
 * before it leaves for the upstream.
 *
 * This lives in the provider adapter rather than the server because it is a
 * property of the provider — "this gateway does not offer an auto route" — and
 * because every entry path (webapi chat, agent-runtime transport, openapi chat
 * service, async image/video) converges on the runtime. Resolving anywhere
 * upstream of here would need the same rewrite repeated per call site.
 *
 * Note the id is resolved *after* authorization: `AicoManagedPolicy` sees the
 * Auto id, which is deliberate — Auto is always permitted and billing is taken
 * from the upstream key's balance delta, not from the model id.
 */

/**
 * Model ids the Auto route may select. Chosen for quality-per-coefficient from
 * the Phase 0 catalog measurement, and each verified to carry the abilities its
 * slot needs:
 *
 * | slot          | model             | coeff | why                                             |
 * | ------------- | ----------------- | ----- | ----------------------------------------------- |
 * | `default`     | `glm-5.3-flash`   | x0.3  | best quality-per-cost; tools + reasoning         |
 * | `reasoning`   | `grok-4.6`        | x0.5  | strongest reasoning per unit cost; tools         |
 * | `vision`      | `gpt-5.6-luna`    | x0.33 | cheapest vision model in the catalog             |
 * | `visionTools` | `gpt-5.6-terra`   | x1.5  | cheapest model with vision *and* tool calling    |
 *
 * `gpt-5.6-luna` does not declare tool calling, which is why a request that
 * needs both vision and tools costs more than one that needs either alone.
 */
export interface CheapVibeCodeAutoRoute {
  default: string;
  reasoning: string;
  vision: string;
  visionTools: string;
}

export const DEFAULT_CVC_AUTO_ROUTE: CheapVibeCodeAutoRoute = {
  default: 'glm-5.3-flash',
  reasoning: 'grok-4.6',
  vision: 'gpt-5.6-luna',
  visionTools: 'gpt-5.6-terra',
};

/**
 * Coefficients drift, so the table is configuration rather than code:
 * `AICO_CVC_AUTO_ROUTE` takes a JSON object of any subset of the slots above and
 * overrides just those. A malformed value is ignored rather than fatal — a bad
 * env var must not take chat down, and the built-in table is always a working
 * answer.
 *
 * The eventual home for this is the platform admin panel alongside the per-model
 * coefficient overrides; the shape here is what that row would store.
 */
export const resolveAutoRoute = (
  raw: string | undefined = process.env.AICO_CVC_AUTO_ROUTE,
): CheapVibeCodeAutoRoute => {
  if (!raw?.trim()) return DEFAULT_CVC_AUTO_ROUTE;
  try {
    const parsed = JSON.parse(raw) as Partial<Record<keyof CheapVibeCodeAutoRoute, unknown>>;
    const pick = (slot: keyof CheapVibeCodeAutoRoute): string => {
      const value = parsed[slot];
      return typeof value === 'string' && value.trim()
        ? value.trim()
        : DEFAULT_CVC_AUTO_ROUTE[slot];
    };
    return {
      default: pick('default'),
      reasoning: pick('reasoning'),
      vision: pick('vision'),
      visionTools: pick('visionTools'),
    };
  } catch {
    console.warn('[cheapvibecode] AICO_CVC_AUTO_ROUTE is not valid JSON; using the default route');
    return DEFAULT_CVC_AUTO_ROUTE;
  }
};

const AUTO_SUFFIX = 'auto';

/**
 * Every spelling of the product Auto router.
 *
 * Kept in step with `isManagedAutoModelId` in
 * `packages/business/const/src/openrouterDefaultModels.ts`, which is the
 * authoritative version; duplicated because `model-runtime` is a shared package
 * and does not depend on the fork's business constants. Matching on the `/auto`
 * suffix rather than an id list is what keeps the two from drifting: a provider
 * id this file has never heard of still routes.
 */
export const isAutoModelId = (modelId: string | null | undefined): boolean => {
  const id = modelId?.trim().toLowerCase();
  if (!id) return false;
  if (id === AUTO_SUFFIX) return true;
  const slash = id.lastIndexOf('/');
  return slash > 0 && id.slice(slash + 1) === AUTO_SUFFIX;
};

const hasImageContent = (payload: ChatStreamPayload): boolean =>
  (payload.messages ?? []).some(
    (message) =>
      Array.isArray(message.content) &&
      message.content.some((part) => (part as { type?: string })?.type === 'image_url'),
  );

const wantsReasoning = (payload: ChatStreamPayload): boolean => {
  const thinking = (payload as { thinking?: { type?: string } }).thinking;
  if (thinking?.type === 'enabled') return true;
  const effort = (payload as { reasoning_effort?: string }).reasoning_effort;
  return Boolean(effort && effort !== 'none' && effort !== 'minimal');
};

/**
 * The concrete model an Auto request should run as. Returns `payload.model`
 * unchanged for anything that is not Auto.
 */
export const resolveAutoModel = (
  payload: ChatStreamPayload,
  route: CheapVibeCodeAutoRoute = resolveAutoRoute(),
): string => {
  if (!isAutoModelId(payload.model)) return payload.model;

  const needsTools = Boolean(payload.tools?.length);
  if (hasImageContent(payload)) return needsTools ? route.visionTools : route.vision;
  if (wantsReasoning(payload)) return route.reasoning;
  return route.default;
};
