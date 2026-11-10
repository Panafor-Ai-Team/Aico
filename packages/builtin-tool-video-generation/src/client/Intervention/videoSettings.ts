import type { VideoModelParamsSchema } from 'model-bank';

import type { GeneratedVideoSettings } from '../../types';

/**
 * Video options the confirm card lets the user pick, in display order. Pixel
 * `size` is left out: CheapVibeCode (the managed runtime) ignores it, so the
 * frame is chosen through quality + aspect ratio instead.
 */
export const VIDEO_SETTING_KEYS = ['resolution', 'aspectRatio', 'duration'] as const;

export type VideoSettingKey = (typeof VIDEO_SETTING_KEYS)[number];

export interface VideoSettingField {
  key: VideoSettingKey;
  options: string[];
  value: string;
}

const MAX_DURATION_OPTIONS = 60;

/** Every length the model accepts: its enum, else each step between min and max. */
export const videoDurationOptions = (
  spec: NonNullable<VideoModelParamsSchema['duration']>,
): number[] => {
  if (spec.enum?.length) return spec.enum;

  const min = spec.min ?? 1;
  const max = spec.max ?? Math.max(min, spec.default);
  const step = spec.step && spec.step > 0 ? spec.step : 1;
  const options: number[] = [];
  for (
    let seconds = min;
    seconds <= max && options.length < MAX_DURATION_OPTIONS;
    seconds += step
  ) {
    options.push(seconds);
  }
  return options;
};

/**
 * The pickers the model offers, each set to what `generateVideo` would send
 * (`settings` from `resolveVideoRequest`, already fitted to the model).
 */
export const resolveVideoSettingFields = (
  schema: VideoModelParamsSchema,
  settings: GeneratedVideoSettings,
): VideoSettingField[] =>
  VIDEO_SETTING_KEYS.flatMap((key) => {
    const options =
      key === 'duration'
        ? schema.duration
          ? videoDurationOptions(schema.duration).map(String)
          : []
        : (schema[key]?.enum ?? []);
    if (!options.length) return [];

    const current = settings[key] === undefined ? undefined : String(settings[key]);
    const fallback = schema[key]?.default === undefined ? undefined : String(schema[key]?.default);
    const value =
      [current, fallback].find((candidate) => !!candidate && options.includes(candidate)) ??
      options[0];

    return [{ key, options, value }];
  });

/** The picks as `generateVideo` arguments (`duration` in seconds). */
export const toVideoSettingArgs = (fields: VideoSettingField[]): GeneratedVideoSettings =>
  Object.fromEntries(
    fields.map((field) => [
      field.key,
      field.key === 'duration' ? Number(field.value) : field.value,
    ]),
  );
