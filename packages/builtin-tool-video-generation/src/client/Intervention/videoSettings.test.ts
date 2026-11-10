import type { VideoModelParamsSchema } from 'model-bank';
import { describe, expect, it } from 'vitest';

import { resolveVideoRequest } from '../../ExecutionRuntime';
import {
  resolveVideoSettingFields,
  toVideoSettingArgs,
  videoDurationOptions,
} from './videoSettings';

const grokImagineVideo: VideoModelParamsSchema = {
  aspectRatio: { default: '16:9', enum: ['1:1', '16:9', '9:16'] },
  duration: { default: 8, max: 15, min: 1 },
  imageUrl: { default: null },
  prompt: { default: '' },
  resolution: { default: '480p', enum: ['480p', '720p'] },
  size: { default: '848x480', enum: ['848x480', '1280x720'] },
};

describe('videoDurationOptions', () => {
  it('lists every second between min and max', () => {
    expect(videoDurationOptions({ default: 8, max: 15, min: 1 })).toEqual(
      Array.from({ length: 15 }, (_, index) => index + 1),
    );
  });

  it('uses the enum when the model only accepts fixed lengths', () => {
    expect(videoDurationOptions({ default: 5, enum: [5, 10] })).toEqual([5, 10]);
  });
});

describe('resolveVideoSettingFields', () => {
  it('offers quality, aspect ratio and duration set to what generateVideo would send', () => {
    const { settings } = resolveVideoRequest(
      { prompt: 'a 3 second 720p clip of a cat' },
      grokImagineVideo,
    );

    const fields = resolveVideoSettingFields(grokImagineVideo, settings);

    expect(fields.map((field) => [field.key, field.value])).toEqual([
      ['resolution', '720p'],
      ['aspectRatio', '16:9'],
      ['duration', '3'],
    ]);
    // Pixel size is not offered: the managed runtime ignores it.
    expect(fields.some((field) => (field.key as string) === 'size')).toBe(false);
  });

  it('turns the picks into generateVideo arguments with duration in seconds', () => {
    const fields = resolveVideoSettingFields(grokImagineVideo, {
      aspectRatio: '9:16',
      duration: 12,
      resolution: '480p',
    });

    const args = toVideoSettingArgs(fields);

    expect(args).toEqual({ aspectRatio: '9:16', duration: 12, resolution: '480p' });
    expect(resolveVideoRequest({ prompt: 'a cat', ...args }, grokImagineVideo).settings).toEqual(
      args,
    );
  });
});
