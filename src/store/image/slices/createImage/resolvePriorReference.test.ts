import { describe, expect, it } from 'vitest';

import { resolveCreateImageParamsWithPriorReference } from './resolvePriorReference';

const PRIOR = 'https://cdn.example.com/prior.png';

describe('resolveCreateImageParamsWithPriorReference', () => {
  it('injects imageUrls for an edit prompt when refs are empty', () => {
    expect(
      resolveCreateImageParamsWithPriorReference({
        parameters: { prompt: 'add a bird to the previous image' },
        priorUrls: [PRIOR],
        supportsImageUrl: false,
        supportsImageUrls: true,
      }),
    ).toEqual({
      imageUrls: [PRIOR],
      prompt: 'add a bird to the previous image',
    });
  });

  it('injects imageUrl for pronoun-only Persian edit asks', () => {
    expect(
      resolveCreateImageParamsWithPriorReference({
        parameters: { prompt: 'این که همونو عوضش کن' },
        priorUrls: [PRIOR],
        supportsImageUrl: true,
        supportsImageUrls: false,
      }),
    ).toEqual({
      imageUrl: PRIOR,
      prompt: 'این که همونو عوضش کن',
    });
  });

  it('does not inject for a fresh text-to-image prompt', () => {
    expect(
      resolveCreateImageParamsWithPriorReference({
        parameters: { prompt: 'a red apple on a table' },
        priorUrls: [PRIOR],
        supportsImageUrl: true,
        supportsImageUrls: true,
      }),
    ).toEqual({ prompt: 'a red apple on a table' });
  });

  it('does not inject for "another one" (fresh follow-up, not an edit)', () => {
    expect(
      resolveCreateImageParamsWithPriorReference({
        parameters: { prompt: 'another one' },
        priorUrls: [PRIOR],
        supportsImageUrl: true,
        supportsImageUrls: true,
      }),
    ).toEqual({ prompt: 'another one' });
  });

  it('prefers a manual reference over the prior generation', () => {
    const manual = 'https://cdn.example.com/upload.png';
    expect(
      resolveCreateImageParamsWithPriorReference({
        parameters: { imageUrl: manual, prompt: 'edit the previous image' },
        priorUrls: [PRIOR],
        supportsImageUrl: true,
        supportsImageUrls: false,
      }),
    ).toEqual({ imageUrl: manual, prompt: 'edit the previous image' });
  });

  it('does nothing when there is no prior image', () => {
    expect(
      resolveCreateImageParamsWithPriorReference({
        parameters: { prompt: 'change it' },
        priorUrls: [],
        supportsImageUrl: true,
        supportsImageUrls: false,
      }),
    ).toEqual({ prompt: 'change it' });
  });
});
