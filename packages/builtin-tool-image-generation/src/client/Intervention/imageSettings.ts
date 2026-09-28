import type { ModelParamsSchema } from 'model-bank';

/** Image options the confirm card lets the user pick, in display order. */
export const IMAGE_SETTING_KEYS = ['quality', 'resolution', 'size', 'aspectRatio'] as const;

export type ImageSettingKey = (typeof IMAGE_SETTING_KEYS)[number];

export interface ImageSettingField {
  key: ImageSettingKey;
  options: string[];
  value: string;
}

/**
 * The pickers the selected model offers, each set to the user's pick, else the
 * assistant's requested value, else the model default — whichever the model
 * actually accepts. Switching models therefore never keeps an invalid value.
 */
export const resolveImageSettingFields = (
  schema: ModelParamsSchema | undefined,
  requested: Record<string, unknown> | undefined,
  picks: Partial<Record<ImageSettingKey, string>>,
): ImageSettingField[] =>
  IMAGE_SETTING_KEYS.flatMap((key) => {
    const spec = schema?.[key];
    if (!spec?.enum?.length) return [];
    const options = spec.enum;

    const value =
      [picks[key], requested?.[key], spec.default].find(
        (candidate): candidate is string =>
          typeof candidate === 'string' && options.includes(candidate),
      ) ?? options[0];

    return [{ key, options, value }];
  });

/** `parameters` for `generateImage`, with every picker's value written in. */
export const applyImageSettings = (
  parameters: Record<string, unknown> | undefined,
  fields: ImageSettingField[],
): Record<string, unknown> => ({
  ...parameters,
  ...Object.fromEntries(fields.map((field) => [field.key, field.value])),
});
