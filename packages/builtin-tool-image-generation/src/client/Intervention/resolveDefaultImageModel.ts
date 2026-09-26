import { findImageModelByRequestedId, pickDefaultAutoImageModel } from '@lobechat/business-const';

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
 * 1. the model the assistant explicitly asked for, when the account has it
 *    (including vendor-prefix aliases like `gpt-image-2` → `openai/gpt-image-2`);
 * 2. the pinned product default (gpt-image-2, else Muse) across every provider —
 *    Auto never names an image model, and gpt-image-2 may not live under the
 *    OpenRouter provider id (managed / CheapVibeCode slot), so do not filter by
 *    provider first or Muse wins incorrectly;
 * 3. otherwise the first model the account has.
 */
export const resolveDefaultImageModelOption = (
  options: ImageModelOption[],
  requested?: { model?: string; provider?: string },
): ImageModelOption | undefined => {
  if (options.length === 0) return undefined;

  if (requested?.model) {
    const scoped = requested.provider
      ? options.filter((option) => option.provider === requested.provider)
      : options;
    const matched = findImageModelByRequestedId(scoped, (option) => option.model, requested.model);
    if (matched) return matched;
  }

  return pickDefaultAutoImageModel(options, (option) => option.model) ?? options[0];
};
