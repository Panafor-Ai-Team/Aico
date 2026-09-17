import { type ManagedModelRates, rawCostMicroUsd } from './pricing';

/**
 * Deliberately pessimistic: Persian is ~2 UTF-8 bytes per character and
 * tokenizes near one token per character, so bytes / 2 over-counts it slightly
 * and over-counts English by a wide margin.
 */
export const BYTES_PER_TOKEN = 2;
export const IMAGE_PART_TOKENS = 2000;
export const REQUEST_OVERHEAD_TOKENS = 64;
export const EMBEDDING_INPUT_OVERHEAD_TOKENS = 16;
export const MIN_OUTPUT_TOKENS = 256;

const capToWindow = (tokens: number, contextWindow: number | null) =>
  contextWindow && contextWindow > 0 ? Math.min(tokens, contextWindow) : tokens;

const bytesToTokens = (text: string) =>
  Math.ceil(Buffer.byteLength(text, 'utf8') / BYTES_PER_TOKEN);

/**
 * Input tokens a chat request can be charged for. Non-text parts are replaced
 * with a stub so a base64 image is counted as a flat image cost, not as text.
 */
export const estimateChatInputTokens = (
  payload: { messages?: unknown; response_format?: unknown; schema?: unknown; tools?: unknown },
  contextWindow: number | null,
): number => {
  let images = 0;

  const messages = Array.isArray(payload.messages)
    ? payload.messages.map((message) => {
        const content = (message as { content?: unknown })?.content;
        if (!Array.isArray(content)) return message;
        return {
          ...(message as object),
          content: content.map((part) => {
            const type = (part as { type?: unknown })?.type;
            if (type === 'text') return part;
            if (type === 'image_url' || type === 'image') images += 1;
            return { type: 'x' };
          }),
        };
      })
    : payload.messages;

  const text = JSON.stringify({
    messages,
    response_format: payload.response_format,
    schema: payload.schema,
    tools: payload.tools,
  });

  const tokens = bytesToTokens(text) + images * IMAGE_PART_TOKENS + REQUEST_OVERHEAD_TOKENS;
  return capToWindow(tokens, contextWindow);
};

export const estimateEmbeddingInputTokens = (
  input: string | string[],
  contextWindow: number | null,
): number => {
  const items = Array.isArray(input) ? input : [input];
  const tokens = items.reduce(
    (sum, item) => sum + bytesToTokens(String(item ?? '')) + EMBEDDING_INPUT_OVERHEAD_TOKENS,
    0,
  );
  // The window caps each input, not the batch.
  return contextWindow && contextWindow > 0
    ? Math.min(tokens, contextWindow * Math.max(1, items.length))
    : tokens;
};

export const resolveMaxOutputTokens = (params: {
  defaultMax: number;
  modelMax: number | null;
  requested?: number | null;
}): number => {
  const { defaultMax, modelMax, requested } = params;
  if (requested && requested > 0) return Math.trunc(Math.min(requested, modelMax ?? requested));
  return Math.trunc(Math.min(defaultMax, modelMax ?? defaultMax));
};

/** Worst-case raw cost of a chat call: every output token spent, reasoning included. */
export const holdRawForChat = (
  rates: ManagedModelRates,
  estInput: number,
  maxOutput: number,
): number =>
  rawCostMicroUsd(rates, {
    completion: maxOutput,
    prompt: estInput,
    reasoning: rates.reasoningBilledTwice ? maxOutput : 0,
    total: estInput + maxOutput,
  });

/**
 * The largest output cap whose hold still fits `available`, or null when not
 * even {@link MIN_OUTPUT_TOKENS} does. Hold cost is monotonic in output tokens,
 * so a binary search finds the exact boundary.
 */
export const shrinkMaxOutputToFit = (params: {
  available: number;
  estInput: number;
  maxOutput: number;
  rates: ManagedModelRates;
  toSubjectUnit: (raw: number) => number;
}): number | null => {
  const { available, estInput, maxOutput, rates, toSubjectUnit } = params;
  const fits = (tokens: number) =>
    toSubjectUnit(holdRawForChat(rates, estInput, tokens)) <= available;

  if (maxOutput < MIN_OUTPUT_TOKENS || !fits(MIN_OUTPUT_TOKENS)) return null;

  let lo = MIN_OUTPUT_TOKENS;
  let hi = Math.trunc(maxOutput);
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (fits(mid)) lo = mid;
    else hi = mid - 1;
  }
  return lo;
};
