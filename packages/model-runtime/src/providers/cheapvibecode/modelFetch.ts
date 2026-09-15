import type { ChatModelCard, Pricing } from 'model-bank';

import { processMultiProviderModelList } from '../../utils/modelParse';
import type { CheapVibeCodeModelCard, CheapVibeCodeModelsResponse } from './type';

/**
 * CVC tokens bought by one USD of upstream capacity.
 *
 * Mirrors `AICO_CVC_TOKENS_PER_USD` in `packages/env/src/aico.ts`, read from the
 * environment rather than imported because `model-runtime` is a shared package
 * and must not depend on the fork's env schema. The default matches the rate the
 * account was funded at; changing it re-denominates every price this file
 * derives, so change it in both places or not at all.
 */
export const DEFAULT_CVC_TOKENS_PER_USD = 25_000_000;

const tokensPerUsd = (): number => {
  const configured = Number(process.env.AICO_CVC_TOKENS_PER_USD);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_CVC_TOKENS_PER_USD;
};

/**
 * A coefficient, as USD per million tokens.
 *
 * CVC weighs input and output equally — one coefficient covers both — and the
 * probe found cached tokens are charged in full, so no cache-read unit is
 * emitted. Claiming a discount we do not receive would under-state every price
 * the user sees.
 */
export const cvcMultiplierToPricing = (
  multiplier: number | null | undefined,
): Pricing | undefined => {
  const coefficient = Number(multiplier);
  if (!Number.isFinite(coefficient) || coefficient <= 0) return undefined;

  const ratePerMillion = (coefficient * 1_000_000) / tokensPerUsd();
  return {
    units: [
      { name: 'textInput', rate: ratePerMillion, strategy: 'fixed', unit: 'millionTokens' },
      { name: 'textOutput', rate: ratePerMillion, strategy: 'fixed', unit: 'millionTokens' },
    ],
  };
};

export const mapCheapVibeCodeModelCard = (model: CheapVibeCodeModelCard) => {
  const contextWindowTokens = Number(model.context_window);
  const maxOutput = Number(model.max_output_tokens);

  return {
    abilities: {
      functionCall: model.supports_tools ?? undefined,
      reasoning: model.supports_reasoning ?? undefined,
      vision: model.supports_vision ?? undefined,
    },
    contextWindowTokens: Number.isFinite(contextWindowTokens) ? contextWindowTokens : undefined,
    description: model.description ?? undefined,
    displayName: model.display_name ?? model.name ?? model.id,
    id: model.id,
    // Three models in the live catalog report `max_output_tokens: 0`. Passing
    // that through would cap every reply at nothing, so an absent or zero value
    // is treated as "not published" rather than as a limit.
    maxOutput: Number.isFinite(maxOutput) && maxOutput > 0 ? maxOutput : undefined,
    pricing: cvcMultiplierToPricing(model.multiplier),
    type: 'chat' as const,
  };
};

const readModelList = (json: unknown): CheapVibeCodeModelCard[] => {
  const root = (json ?? {}) as CheapVibeCodeModelsResponse;
  const list = root.data ?? root.models;
  return Array.isArray(list) ? list.filter((model) => typeof model?.id === 'string') : [];
};

/**
 * `/v1/models` is not filtered by a key's `allowed_models` — a restricted key
 * still sees the whole catalog — so what comes back here is the provider's
 * inventory, not this key's entitlement. Filtering to what a member may call
 * stays with `AicoManagedPolicy.assertModelAllowed`.
 */
export const fetchCheapVibeCodeModels = async ({
  client,
}: {
  // Structurally satisfied by the OpenAI SDK client the factory passes in;
  // narrowed to the two fields we need so the fetcher stays testable with a
  // plain object. `apiKey` is `string | null` on the SDK client.
  client: { apiKey?: string | null; baseURL?: string | null };
}): Promise<ChatModelCard[]> => {
  const baseURL = (client.baseURL || 'https://cheapvibecode.ru/v1').replace(/\/$/, '');
  const response = await fetch(`${baseURL}/models`, {
    headers: {
      ...(client.apiKey ? { Authorization: `Bearer ${client.apiKey}` } : {}),
      'Content-Type': 'application/json',
    },
    method: 'GET',
  });

  if (!response.ok) {
    // No upstream body in the message: a CVC error can echo the request, and the
    // request carries the key.
    throw new Error(`CheapVibeCode model list failed with HTTP ${response.status}`);
  }

  const formatted = readModelList(await response.json()).map(mapCheapVibeCodeModelCard);
  return processMultiProviderModelList(formatted, 'cheapvibecode');
};
