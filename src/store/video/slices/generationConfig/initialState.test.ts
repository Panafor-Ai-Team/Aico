import { describe, expect, it } from 'vitest';

import {
  DEFAULT_AI_VIDEO_MODEL,
  DEFAULT_AI_VIDEO_PROVIDER,
  initialGenerationConfigState,
} from './initialState';

describe('Create → Video defaults', () => {
  // LobeHub's Seedance is not served by the managed gateway; the default must be
  // a model the managed catalog actually offers.
  it('defaults to Kling Video V3 on the managed slot', () => {
    expect(DEFAULT_AI_VIDEO_PROVIDER).toBe('openrouter');
    expect(DEFAULT_AI_VIDEO_MODEL).toBe('kling-video-v3');
    expect(initialGenerationConfigState.parametersSchema.resolution?.enum).toEqual([
      '720p',
      '1080p',
      '4k',
    ]);
    expect(initialGenerationConfigState.parameters.duration).toBe(5);
  });
});
