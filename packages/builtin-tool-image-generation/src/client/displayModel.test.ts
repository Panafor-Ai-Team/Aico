import { describe, expect, it } from 'vitest';

import { formatImageGenerationModelLabel } from './displayModel';

describe('formatImageGenerationModelLabel', () => {
  it('returns the model id without the managed provider', () => {
    expect(formatImageGenerationModelLabel('gpt-image-2', 'openrouter')).toBe('gpt-image-2');
    expect(formatImageGenerationModelLabel('openai/gpt-image-2', 'openrouter')).toBe(
      'openai/gpt-image-2',
    );
    expect(formatImageGenerationModelLabel('gpt-image-2', 'aico')).toBe('gpt-image-2');
  });

  it('returns undefined when the model is missing', () => {
    expect(formatImageGenerationModelLabel(undefined, 'openrouter')).toBeUndefined();
    expect(formatImageGenerationModelLabel('  ', 'openrouter')).toBeUndefined();
  });
});
