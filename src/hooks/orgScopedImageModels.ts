import { isDefaultAutoImageModelId } from '@lobechat/business-const';
import type { AiModelForSelect, AiProviderModelListItem } from 'model-bank';

/**
 * Catalog rows for image generation, narrowed to what an org member may use.
 *
 * Mirrors the org-wallet rule the chat model list already applies: the team
 * allow-list decides, except for the product's own default. Auto
 * (`openrouter/auto`) is that exception for chat; the pinned image generator is
 * the exception here — an org member must be able to ask for an image without an
 * admin first granting a model the picker never showed them.
 */
export const filterOrgScopedImageModels = (
  catalog: AiProviderModelListItem[],
  allowedModelIds: string[],
): AiModelForSelect[] => {
  const allowSet = new Set(allowedModelIds);

  return catalog
    .filter(
      (model) =>
        (model.type || 'chat') === 'image' &&
        (allowSet.has(model.id) || isDefaultAutoImageModelId(model.id)),
    )
    .map((model) => ({
      abilities: (model.abilities || {}) as AiModelForSelect['abilities'],
      contextWindowTokens: model.contextWindowTokens,
      description: model.description,
      displayName: model.displayName,
      family: model.family,
      generation: model.generation,
      id: model.id,
      knowledgeCutoff: model.knowledgeCutoff,
      parameters: model.parameters,
      pricing: model.pricing,
      releasedAt: model.releasedAt,
    }));
};
