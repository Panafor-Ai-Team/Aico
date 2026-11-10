import { describe, expect, it } from 'vitest';

import { CURATED_MODEL_RATINGS } from './modelRatings';
import { applyBusinessModelRating } from './useBusinessModelRating';

describe('curated model ratings', () => {
  it('resolves a managed model from its catalog id', () => {
    const rating = applyBusinessModelRating({ model: 'glm-5.3-flash', provider: 'cheapvibecode' });

    expect(rating?.intelligence?.score).toBe(42);
    expect(rating?.speed).toMatchObject({ raw: 73.5, source: 'artificial-analysis' });
    // pool-relative price: glm ($0.10/M) is second cheapest after mimo-v2.5 ($0.0552/M)
    expect(rating?.price?.score).toBe(99);
    // pool-relative Elo: AA-Briefcase spans mimo (754) … fable (1671)
    expect(rating?.agentic).toMatchObject({ raw: 1452, score: 76 });
    expect(rating?.design).toMatchObject({
      raw: 1385,
      score: 75,
      source: 'design-arena',
      sourceUrl: 'https://benchmarklist.com/models/z-ai-glm-5.3-flash',
    });
  });

  it('resolves models whose AA page slug differs from their catalog id', () => {
    expect(applyBusinessModelRating({ model: 'qwen3.8-flash' })).toMatchObject({
      intelligence: {
        score: 40,
        sourceUrl: 'https://artificialanalysis.ai/models/qwen3-8-flash-next',
      },
    });

    const mimo = applyBusinessModelRating({ model: 'mimo-v2.5' });
    expect(mimo?.intelligence?.score).toBe(22);
    expect(mimo?.price).toMatchObject({
      // cheapest in the pool
      score: 100,
      raw: 0.0552,
      sourceUrl: 'https://artificialanalysis.ai/models/mimo-v2-5-0424',
    });
    expect(mimo?.agentic).toMatchObject({
      // AA-Briefcase floor of the pool
      score: 0,
      raw: 754,
    });
  });

  it('strips a vendor prefix and misses unrated models', () => {
    expect(
      applyBusinessModelRating({ model: 'deepseek/deepseek-v4.1-flash' })?.intelligence?.score,
    ).toBe(39);
    expect(applyBusinessModelRating({ model: 'some-unknown-model' })).toBeUndefined();
    expect(applyBusinessModelRating({})).toBeUndefined();
  });

  it('keeps every entry inside the rating schema', () => {
    expect(Object.keys(CURATED_MODEL_RATINGS)).toContain('claude-fable-5-1');

    for (const [id, rating] of Object.entries(CURATED_MODEL_RATINGS)) {
      expect(rating.intelligence, id).toBeDefined();

      for (const dimension of Object.values(rating)) {
        expect(dimension.score, id).toBeGreaterThanOrEqual(0);
        expect(dimension.score, id).toBeLessThanOrEqual(100);
        expect(dimension.updatedAt, id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        if (dimension.source === 'design-arena') {
          expect(dimension.sourceUrl, id).toMatch(/^https:\/\/benchmarklist\.com\/models\//);
        } else {
          expect(dimension.sourceUrl, id).toMatch(/^https:\/\/artificialanalysis\.ai\/models\//);
        }
      }
    }
  });

  it('gives the radar enough dimensions for every model ranked in Design Arena', () => {
    // RADAR_MIN_DIMENSIONS (ModelRatingRadar) — below it the panel shows a list instead
    const radarModels = Object.entries(CURATED_MODEL_RATINGS)
      .filter(([, rating]) => rating.design)
      .map(([id]) => id);

    expect(radarModels).toEqual([
      'claude-fable-5-1',
      'claude-sonnet-5',
      'glm-5.3-flash',
      'gpt-5.6-luna',
      'gpt-5.6-terra',
      'mimo-v2.5',
    ]);

    for (const id of radarModels) {
      expect(Object.keys(CURATED_MODEL_RATINGS[id]), id).toHaveLength(5);
    }

    expect(applyBusinessModelRating({ model: 'claude-fable-5-1' })?.agentic).toMatchObject({
      // AA-Briefcase top of the pool
      score: 100,
      raw: 1671,
    });
  });
});
