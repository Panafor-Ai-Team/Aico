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

  it('asks before every interactive generation, whatever the approval mode', async () => {
    for (const approvalMode of ['manual', 'allow-list', 'auto-run', undefined]) {
      await expect(
        imageGenerationModelConfirmAudit({}, { approvalMode, topicId: 'topic-1' }),
      ).resolves.toBe(true);
    }
  });

  it('keeps asking after a model was confirmed, so settings can be picked each time', async () => {
    setConfirmedImageModel('topic-1', { model: 'meta/muse-image', provider: 'openrouter' });

    await expect(
      imageGenerationModelConfirmAudit({}, { approvalMode: 'manual', topicId: 'topic-1' }),
    ).resolves.toBe(true);
  });

  it('never asks in headless runs, which have no card to answer', async () => {
    await expect(
      imageGenerationModelConfirmAudit({}, { approvalMode: 'headless', topicId: 'topic-1' }),
    ).resolves.toBe(false);
  });

  it('keeps confirmed models scoped to their conversation', () => {
    setConfirmedImageModel('topic-1', { model: 'meta/muse-image', provider: 'openrouter' });

    expect(getConfirmedImageModel('topic-1')).toEqual({
      model: 'meta/muse-image',
      provider: 'openrouter',
    });
    expect(getConfirmedImageModel('topic-2')).toBeUndefined();
  });

  it('shares one slot for conversations without a topic id', () => {
    setConfirmedImageModel(undefined, { model: 'meta/muse-image', provider: 'openrouter' });

    expect(getConfirmedImageModel(undefined)).toEqual({
      model: 'meta/muse-image',
      provider: 'openrouter',
    });
  });
});
