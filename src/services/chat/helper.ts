import type { EnabledAiModel } from 'model-bank';
import { ModelProvider } from 'model-bank/modelProvider';

import { getAiInfraStoreState } from '@/store/aiInfra';
import { aiModelSelectors, aiProviderSelectors } from '@/store/aiInfra/selectors';

export const getEnabledRuntimeModel = (
  model: string,
  provider: string,
): EnabledAiModel | undefined => {
  const state = getAiInfraStoreState();
  // Alias-tolerant like the rest of the capability gates: a stored
  // `openrouter/<model>` selection keeps resolving after a gateway cutover.
  const matchedModel = aiModelSelectors.getEnabledModelById(model, provider)(state);

  if (matchedModel || provider !== ModelProvider.LobeHub) return matchedModel;

  return state.enabledAiModels?.find((item) => item.id === model);
};

const getModelAbilities = (model: string, provider: string) => {
  return getEnabledRuntimeModel(model, provider)?.abilities;
};

export const isCanUseVision = (model: string, provider: string): boolean => {
  return getModelAbilities(model, provider)?.vision || false;
};

export const isCanUseVideo = (model: string, provider: string): boolean => {
  return getModelAbilities(model, provider)?.video || false;
};

export const isCanUseAudio = (model: string, provider: string): boolean => {
  return getModelAbilities(model, provider)?.audio || false;
};

export const getRuntimeModelKnowledgeCutoff = (
  model: string,
  provider: string,
): string | undefined => getEnabledRuntimeModel(model, provider)?.knowledgeCutoff;

export const getRuntimeModelDisplayName = (model: string, provider: string): string | undefined =>
  getEnabledRuntimeModel(model, provider)?.displayName;

/**
 * TODO: we need to update this function to auto find deploymentName with provider setting config
 */
export const findDeploymentName = (model: string, provider: string) => {
  let deploymentId = model;

  // find the model by id
  const modelItem = getAiInfraStoreState().enabledAiModels?.find(
    (i) => i.id === model && i.providerId === provider,
  );

  if (modelItem && modelItem.config?.deploymentName) {
    deploymentId = modelItem.config?.deploymentName;
  }

  return deploymentId;
};

export const isEnableFetchOnClient = (provider: string) => {
  return aiProviderSelectors.isProviderFetchOnClient(provider)(getAiInfraStoreState());
};

export const resolveRuntimeProvider = (provider: string) => {
  const isBuiltin = Object.values(ModelProvider).includes(provider as any);
  if (isBuiltin) return provider;

  const providerConfig = aiProviderSelectors.providerConfigById(provider)(getAiInfraStoreState());

  return providerConfig?.settings.sdkType || 'openai';
};

// Below this the gzip round trip saves less than it costs; chat bodies that
// carry history and tools are hundreds of KB and shrink ~3–4×.
export const GZIP_REQUEST_BODY_MIN_BYTES = 32 * 1024;

/**
 * Gzip a JSON request body before upload when it is large and the browser can
 * compress. Returns an ArrayBuffer (reusable if the request is retried) and
 * whether it is gzipped, so the caller sets `Content-Encoding`. Any failure
 * falls back to the plain string.
 */
export const encodeJsonRequestBody = async (
  json: string,
): Promise<{ body: ArrayBuffer | string; gzip: boolean }> => {
  if (typeof CompressionStream === 'undefined') return { body: json, gzip: false };

  const bytes = new TextEncoder().encode(json);
  if (bytes.byteLength < GZIP_REQUEST_BODY_MIN_BYTES) return { body: json, gzip: false };

  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
    return { body: await new Response(stream).arrayBuffer(), gzip: true };
  } catch {
    return { body: json, gzip: false };
  }
};
