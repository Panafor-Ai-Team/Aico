import { beforeEach, describe, expect, it } from 'vitest';

import {
  clearConfirmedImageModels,
  getConfirmedImageModel,
  imageGenerationModelConfirmAudit,
  setConfirmedImageModel,
} from './confirmation';

describe('image generation confirmation', () => {
  beforeEach(() => {
    clearConfirmedImageModels();
  });

  it('asks for confirmation on the first generation of a conversation', async () => {
    await expect(imageGenerationModelConfirmAudit({}, { topicId: 'topic-1' })).resolves.toBe(true);
  });

  it('stops asking once the conversation has a confirmed model', async () => {
    setConfirmedImageModel('topic-1', { model: 'meta/muse-image', provider: 'openrouter' });

    await expect(imageGenerationModelConfirmAudit({}, { topicId: 'topic-1' })).resolves.toBe(false);
    // A retry with different arguments must not re-open the card either.
    await expect(
      imageGenerationModelConfirmAudit({ model: 'other/model' }, { topicId: 'topic-1' }),
    ).resolves.toBe(false);
  });

  it('keeps confirmations scoped to their conversation', async () => {
    setConfirmedImageModel('topic-1', { model: 'meta/muse-image', provider: 'openrouter' });

    expect(getConfirmedImageModel('topic-1')).toEqual({
      model: 'meta/muse-image',
      provider: 'openrouter',
    });
    expect(getConfirmedImageModel('topic-2')).toBeUndefined();
    await expect(imageGenerationModelConfirmAudit({}, { topicId: 'topic-2' })).resolves.toBe(true);
  });

  it('shares one slot for conversations without a topic id', async () => {
    setConfirmedImageModel(undefined, { model: 'meta/muse-image', provider: 'openrouter' });

    await expect(imageGenerationModelConfirmAudit({}, {})).resolves.toBe(false);
    await expect(imageGenerationModelConfirmAudit({}, undefined)).resolves.toBe(false);
  });
});
