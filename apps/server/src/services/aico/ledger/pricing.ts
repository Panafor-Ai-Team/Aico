import {
  type ChatStreamPayload,
  type CheapVibeCodeAutoRoute,
  isAutoModelId,
  resolveAutoModel,
  resolveAutoRoute,
} from '@lobechat/model-runtime';
import cvcModels from 'model-bank/cheapvibecode';

import { OpenRouterModelCatalogModel } from '@/database/models/openrouterModelCatalog';
import type { LobeChatDatabase } from '@/database/type';

import { getCachedModelMultiplierOverrides } from '../usageMultiplier';

/**
 * Models whose measured charge counts reasoning tokens a second time
 * (`deepseek-v4.1-flash` ~x0.433 against a published x0.3).
 */
export const REASONING_BILLED_TWICE = new Set(['deepseek-v4.1-flash', 'mimo-v2.5']);

export interface ManagedModelRates {
  contextWindowTokens: number | null;
  /** Pico-USD per token, so fractional µUSD rates stay integers. */
  inputPusdPerToken: bigint;
  maxOutputTokens: number | null;
  /** Per-model coefficient correction; 10,000 when none. */
  modelBp: number;
  /** Null for input-only models (embeddings). */
  outputPusdPerToken: bigint | null;
  pricedModelId: string;
  reasoningBilledTwice: boolean;
}

export interface UsageTokens {
  completion: number;
  prompt: number;
  reasoning: number;
  total: number;
}

const CATALOG_CACHE_MS = 60_000;
const BP_ONE = 10_000n;

interface PricingRow {
  contextWindowTokens: number | null;
  id: string;
  maxOutput: number | null;
  pricing: unknown;
}

let catalogCache: { expiresAt: number; rows: Map<string, PricingRow> } | null = null;

export const resetManagedPricingCacheForTests = () => {
  catalogCache = null;
};

/** USD per million tokens → pico-USD per token, rounded up. */
export const rateToPusdPerToken = (usdPerMillion: number): bigint =>
  BigInt(Math.ceil(Math.round(usdPerMillion * 1e9) / 1e3));

interface PricingUnitLike {
  name?: string;
  rate?: unknown;
  strategy?: string;
  unit?: string;
}

const findFixedRate = (pricing: unknown, name: string): number | null | 'unsupported' => {
  const units = (pricing as { units?: PricingUnitLike[] } | null)?.units;
  if (!Array.isArray(units)) return null;
  const unit = units.find((u) => u?.name === name);
  if (!unit) return null;
  if (unit.strategy !== 'fixed' || unit.unit !== 'millionTokens') return 'unsupported';
  const rate = Number(unit.rate);
  return Number.isFinite(rate) && rate >= 0 ? rate : 'unsupported';
};

const loadCatalog = async (db: LobeChatDatabase): Promise<Map<string, PricingRow>> => {
  const now = Date.now();
  if (catalogCache && catalogCache.expiresAt > now) return catalogCache.rows;

  const rows = await new OpenRouterModelCatalogModel(db).listPricingRows();
  const map = new Map(rows.map((row) => [row.id, row as PricingRow]));
  catalogCache = { expiresAt: now + CATALOG_CACHE_MS, rows: map };
  return map;
};

const toPositiveIntOrNull = (value: unknown): number | null => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
};

/**
 * Rates for one concrete CVC model id, or null when it cannot be priced.
 *
 * The synced catalog wins; the bundled CVC snapshot covers only an id the
 * catalog does not have, by exact id. Cross-provider pricing lookups are never
 * used: they could price a CVC model with another gateway's rate.
 */
export const getManagedModelRates = async (
  db: LobeChatDatabase,
  modelId: string,
): Promise<ManagedModelRates | null> => {
  if (!modelId) return null;

  const catalog = await loadCatalog(db);
  const bundled = cvcModels.find((model) => model.id === modelId);
  const row: PricingRow | undefined =
    catalog.get(modelId) ??
    (bundled
      ? {
          contextWindowTokens: bundled.contextWindowTokens ?? null,
          id: bundled.id,
          maxOutput: bundled.maxOutput ?? null,
          pricing: bundled.pricing,
        }
      : undefined);
  if (!row) return null;

  const input = findFixedRate(row.pricing, 'textInput');
  const output = findFixedRate(row.pricing, 'textOutput');
  if (input === null || input === 'unsupported' || output === 'unsupported') return null;

  const overrides = await getCachedModelMultiplierOverrides(db);

  return {
    contextWindowTokens: toPositiveIntOrNull(row.contextWindowTokens),
    inputPusdPerToken: rateToPusdPerToken(input),
    maxOutputTokens: toPositiveIntOrNull(row.maxOutput),
    modelBp: toPositiveIntOrNull(overrides[modelId]) ?? 10_000,
    outputPusdPerToken: output === null ? null : rateToPusdPerToken(output),
    pricedModelId: modelId,
    reasoningBilledTwice: REASONING_BILLED_TWICE.has(modelId),
  };
};

const maxPerTokenRate = (rates: ManagedModelRates) =>
  rates.inputPusdPerToken + (rates.outputPusdPerToken ?? 0n);

/**
 * Rates for a chat payload. Auto is priced as the model the runtime will route
 * it to, and if that model is unpriced, as the most expensive priced slot.
 */
export const resolveChatRates = async (
  db: LobeChatDatabase,
  payload: ChatStreamPayload,
  route: CheapVibeCodeAutoRoute = resolveAutoRoute(),
): Promise<{ modelId: string; rates: ManagedModelRates } | null> => {
  if (!isAutoModelId(payload.model)) {
    const rates = await getManagedModelRates(db, payload.model);
    return rates ? { modelId: payload.model, rates } : null;
  }

  const target = resolveAutoModel(payload, route);
  const targetRates = await getManagedModelRates(db, target);
  if (targetRates) return { modelId: target, rates: targetRates };

  let best: ManagedModelRates | null = null;
  for (const slot of new Set(Object.values(route))) {
    const rates = await getManagedModelRates(db, slot);
    if (rates && (!best || maxPerTokenRate(rates) > maxPerTokenRate(best))) best = rates;
  }
  return best ? { modelId: best.pricedModelId, rates: best } : null;
};

const nonNegBig = (value: number) => BigInt(Math.max(0, Math.trunc(Number(value) || 0)));

/**
 * Raw µUSD a call cost upstream, recomputed from tokens (never from a
 * provider-reported cost). The model correction and reasoning double-billing
 * describe the same discrepancy, so the larger of the two is charged, never both.
 */
export const rawCostMicroUsd = (rates: ManagedModelRates, tokens: UsageTokens): number => {
  const prompt = nonNegBig(tokens.prompt);
  const completion = nonNegBig(tokens.completion);
  const beyondPrompt = nonNegBig(tokens.total) - prompt;
  const out = beyondPrompt > completion ? beyondPrompt : completion;
  const reasoning = nonNegBig(tokens.reasoning);
  const outRate = rates.outputPusdPerToken ?? 0n;

  const base = prompt * rates.inputPusdPerToken + out * outRate;
  const twice = rates.reasoningBilledTwice ? base + reasoning * outRate : base;
  const corrected = (base * BigInt(rates.modelBp) + (BP_ONE - 1n)) / BP_ONE;
  const pusd = twice > corrected ? twice : corrected;

  return Number((pusd + 999_999n) / 1_000_000n);
};
