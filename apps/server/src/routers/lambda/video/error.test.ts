import { describe, expect, it } from 'vitest';

import { AsyncTaskErrorType } from '@/types/asyncTask';

import { createVideoTaskSubmitError } from './error';

describe('createVideoTaskSubmitError', () => {
  it('should use task trigger error for generic submit failures', () => {
    const error = createVideoTaskSubmitError(new Error('API timeout'));

    expect(error.name).toBe(AsyncTaskErrorType.TaskTriggerError);
    expect(error.body.detail).toBe('Failed to submit video task: API timeout');
  });

  it('should use provider moderation type for content policy failures', () => {
    const error = createVideoTaskSubmitError(
      new Error('rejected by safety system'),
      'Content policy check failed. Revise your prompt and try again.',
    );

    expect(error.name).toBe(AsyncTaskErrorType.ProviderContentModeration);
    expect(error.body.detail).toBe(
      'Content policy check failed. Revise your prompt and try again.',
    );
  });

  it('should propagate the provider status and response body from a rejected request', () => {
    // Mirrors what packages/model-runtime/.../openrouter/createVideo.ts now throws
    // when OpenRouter rejects a request carrying a reference image.
    const error = createVideoTaskSubmitError(
      new Error('Video generation failed (400): input_references[0] must be an object'),
    );

    expect(error.name).toBe(AsyncTaskErrorType.TaskTriggerError);
    expect(error.body.detail).toBe(
      'Failed to submit video task: Video generation failed (400): input_references[0] must be an object',
    );
  });
});
