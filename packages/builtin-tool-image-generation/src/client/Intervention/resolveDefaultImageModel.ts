import {
  DEFAULT_AUTO_IMAGE_MODEL_PROVIDER,
  pickDefaultAutoImageModel,
} from '@lobechat/business-const';

export interface ImageModelOption {
  displayName: string;
  model: string;
  provider: string;
  providerName: string;
}

/**
 * `provider/model` — unique across providers, so it is safe as a select value.
 */
export const imageModelOptionKey = (option: { model: string; provider: string }) =>
  `${option.provider}/${option.model}`;

/**
 * Pick what the confirmation card should propose:
 * 1. the model the assistant explicitly asked for, when the account has it;
 * 2. the pinned product default (GPT Image 2, else Muse on OpenRouter) — this
 *    is the branch the Auto router lands on, since Auto never names an image model;
 * 3. otherwise the first model the account has.
 */
export const resolveDefaultImageModelOption = (
  options: ImageModelOption[],
  requested?: { model?: string; provider?: string },
): ImageModelOption | undefined => {
  if (options.length === 0) return undefined;

  if (requested?.model) {
    const matched = options.find(
      (option) =>
        option.model === requested.model &&
        (!requested.provider || option.provider === requested.provider),
    );
    if (matched) return matched;
  }

  const pinned =
    pickDefaultAutoImageModel(
      options.filter((option) => option.provider === DEFAULT_AUTO_IMAGE_MODEL_PROVIDER),
      (option) => option.model,
    ) ?? pickDefaultAutoImageModel(options, (option) => option.model);

  return pinned ?? options[0];
};
