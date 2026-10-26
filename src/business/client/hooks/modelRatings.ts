import type { ModelBenchmarkScore, ModelRating, ModelRatingSource } from 'model-bank';

/**
 * Curated benchmark data behind `applyBusinessModelRating` — the seam upstream
 * fills from their own dataset (the OSS build ships a stub, so Benchmarks
 * never rendered here).
 *
 * Every raw value below was read from the model's public Artificial Analysis
 * page on 2026-10-26 (Intelligence Index v4.3.2, AA-Briefcase v1.1 Elo, median
 * output tokens/s, and the AA-published 7:2:1 blended $/M price). `intelligence`
 * keeps AA's own 0-100 index; `speed`, `price` and the Elo dimensions have no
 * 0-100 scale upstream, so they are normalized pool-relative across this
 * snapshot (best model scores 100, price inverted). `design` is the Design
 * Arena Elo — not every model competes in that arena — as published on
 * benchmarklist.com (which mirrors their leaderboard). Models without a row
 * here show no Benchmarks section; models without `design` show the list
 * instead of the radar (the radar needs 5+ dimensions).
 */
const COLLECTED_AT = '2026-10-26';

const SOURCE_URL = (id: string) =>
  `https://artificialanalysis.ai/models/${id.replaceAll('.', '-')}`;

/** AA publishes one page per model; the slug usually is the catalog id with dots dashed. */
interface AASnapshot {
  /** AA-Briefcase v1.1 Elo, from the model's AA page */
  agenticElo: number;
  /** AA-published blended $/M (7:2:1 cache hit/input/output) */
  blendedPricePerMillion: number;
  /** Design Arena Elo, when the model competes there (mirrored on benchmarklist.com) */
  design?: { elo: number; mirroredOn: string; sampledAt: string };
  /** catalog model id; a vendor prefix (`deepseek/…`) is stripped before lookup */
  id: string;
  /** Artificial Analysis Intelligence Index (0-100) */
  intelligence: number;
  /** AA page slug when it differs from the dash-cased catalog id */
  slug?: string;
  /** median output tokens per second */
  tokensPerSecond: number;
}

const SNAPSHOTS: AASnapshot[] = [
  {
    agenticElo: 1671,
    blendedPricePerMillion: 7.17,
    design: { elo: 1418, mirroredOn: 'anthropic-claude-fable-5.1', sampledAt: '2026-09-02' },
    id: 'claude-fable-5-1',
    intelligence: 53,
    tokensPerSecond: 70.1,
  },
  {
    agenticElo: 1657,
    blendedPricePerMillion: 3.85,
    id: 'claude-opus-5',
    intelligence: 51,
    tokensPerSecond: 52.3,
  },
  {
    agenticElo: 1357,
    blendedPricePerMillion: 1.54,
    design: { elo: 1329, mirroredOn: 'anthropic-claude-sonnet-5', sampledAt: '2026-08-24' },
    id: 'claude-sonnet-5',
    intelligence: 38,
    tokensPerSecond: 83.2,
  },
  {
    agenticElo: 1419,
    blendedPricePerMillion: 0.18,
    id: 'deepseek-v4.1-flash',
    intelligence: 39,
    tokensPerSecond: 174.5,
  },
  {
    agenticElo: 1202,
    blendedPricePerMillion: 0.58,
    id: 'gemini-3.8-flash',
    intelligence: 41,
    tokensPerSecond: 132.2,
  },
  {
    agenticElo: 1452,
    blendedPricePerMillion: 0.1,
    design: { elo: 1385, mirroredOn: 'z-ai-glm-5.3-flash', sampledAt: '2026-09-02' },
    id: 'glm-5.3-flash',
    intelligence: 42,
    tokensPerSecond: 73.5,
  },
  {
    agenticElo: 1339,
    blendedPricePerMillion: 0.17,
    design: { elo: 1285, mirroredOn: 'openai-gpt-5.6-luna', sampledAt: '2026-09-02' },
    id: 'gpt-5.6-luna',
    intelligence: 37,
    tokensPerSecond: 125.9,
  },
  {
    agenticElo: 1332,
    blendedPricePerMillion: 1.74,
    design: { elo: 1289, mirroredOn: 'openai-gpt-5.6-terra', sampledAt: '2026-08-24' },
    id: 'gpt-5.6-terra',
    intelligence: 42,
    tokensPerSecond: 134.7,
  },
  {
    agenticElo: 1531,
    blendedPricePerMillion: 1.35,
    id: 'grok-4.6',
    intelligence: 44,
    tokensPerSecond: 76.5,
  },
  {
    // deprecated upstream (AA suggests V2.6-Pro) but the page still publishes all values
    agenticElo: 754,
    blendedPricePerMillion: 0.0552,
    design: { elo: 1288, mirroredOn: 'xiaomi-mimo-v2.5', sampledAt: '2026-08-24' },
    id: 'mimo-v2.5',
    intelligence: 22,
    slug: 'mimo-v2-5-0424',
    tokensPerSecond: 38.6,
  },
  {
    // published as Qwen3.8-Flash-Next (the Qwen docs' served id is qwen3.8-flash)
    agenticElo: 1575,
    blendedPricePerMillion: 0.0882,
    id: 'qwen3.8-flash',
    intelligence: 40,
    slug: 'qwen3-8-flash-next',
    tokensPerSecond: 51.7,
  },
];

/** 0-100 where `best` scores 100 and `worst` scores 0 (price passes best=minPrice). */
const normalize = (value: number, best: number, worst: number): number =>
  best === worst ? 50 : Math.round(((value - worst) / (best - worst)) * 100);

const values = (pick: (snapshot: AASnapshot) => number) => SNAPSHOTS.map(pick);
const [maxSpeed, minSpeed] = [
  Math.max(...values((s) => s.tokensPerSecond)),
  Math.min(...values((s) => s.tokensPerSecond)),
];
const [minPrice, maxPrice] = [
  Math.min(...values((s) => s.blendedPricePerMillion)),
  Math.max(...values((s) => s.blendedPricePerMillion)),
];
const [maxBriefcase, minBriefcase] = [
  Math.max(...values((s) => s.agenticElo)),
  Math.min(...values((s) => s.agenticElo)),
];
const designElos = SNAPSHOTS.flatMap((s) => (s.design ? [s.design.elo] : []));
const [maxDesign, minDesign] = [Math.max(...designElos), Math.min(...designElos)];

const aaScore = (sourceUrl: string, score: number, raw?: number): ModelBenchmarkScore => {
  const dimension: ModelBenchmarkScore = {
    score,
    source: 'artificial-analysis' as ModelRatingSource,
    sourceUrl,
    updatedAt: COLLECTED_AT,
  };

  if (raw !== undefined) dimension.raw = raw;

  return dimension;
};

export const CURATED_MODEL_RATINGS: Record<string, ModelRating> = Object.fromEntries(
  SNAPSHOTS.map(
    ({ agenticElo, blendedPricePerMillion, design, id, intelligence, slug, tokensPerSecond }) => {
      const sourceUrl = SOURCE_URL(slug ?? id);

      return [
        id,
        {
          agentic: aaScore(
            sourceUrl,
            normalize(agenticElo, maxBriefcase, minBriefcase),
            agenticElo,
          ),
          ...(design && {
            design: {
              raw: design.elo,
              score: normalize(design.elo, maxDesign, minDesign),
              source: 'design-arena',
              sourceUrl: `https://benchmarklist.com/models/${design.mirroredOn}`,
              updatedAt: design.sampledAt,
            },
          }),
          intelligence: aaScore(sourceUrl, intelligence),
          price: aaScore(
            sourceUrl,
            normalize(blendedPricePerMillion, minPrice, maxPrice),
            blendedPricePerMillion,
          ),
          speed: aaScore(
            sourceUrl,
            normalize(tokensPerSecond, maxSpeed, minSpeed),
            tokensPerSecond,
          ),
        } satisfies ModelRating,
      ];
    },
  ),
);
