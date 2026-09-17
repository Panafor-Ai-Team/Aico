import { describe, expect, it } from 'vitest';

import {
  DEFAULT_AI_IMAGE_MODEL,
  DEFAULT_IMAGE_GENERATION_PARAMETERS,
  initialGenerationConfigState,
} from './initialState';

describe('initialGenerationConfigState', () => {
  it('defaults to GPT Image 2 at medium quality', () => {
    expect(DEFAULT_AI_IMAGE_MODEL).toBe('gpt-image-2');
    expect(initialGenerationConfigState.model).toBe('gpt-image-2');
    expect(initialGenerationConfigState.parametersSchema.quality?.enum).toEqual([
      'low',
      'medium',
      'high',
      'auto',
    ]);
    expect(DEFAULT_IMAGE_GENERATION_PARAMETERS.quality).toBe('medium');
  });
});
