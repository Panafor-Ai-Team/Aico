import { ImageGenerationApiName, ImageGenerationIdentifier } from './types';

/** OpenAI-style tool function name for `generateImage`. */
export const IMAGE_GENERATION_TOOL_FUNCTION_NAME = `${ImageGenerationIdentifier}____${ImageGenerationApiName.generateImage}`;

const META_QUESTION =
  /(?:^|\s)(?:how\s+(?:do|to|can|should)|what\s+is|چطور|چگونه|نحوه|write\s+(?:me\s+)?(?:a\s+)?prompt|پرامپت\s*(?:بنویس|بساز)?)/i;

const IMAGE_NOUN =
  /(?:عکس|تصویر|نگاره|نقاشی|رسم|photo|picture|image|illustration|artwork|drawing)\b/i;

const GENERATE_VERB =
  /(?:بساز|بکش|بده|درست\s*کن|تولید|generate|create|draw|make|paint|render|imagine)\b/i;

const ENGLISH_IMAGE_COMMAND =
  /^(?:generate|create|draw|make|paint|render)\s+(?:an?\s+)?(?:image|picture|photo)\b/i;

const stripPersianIndefinite = (text: string) =>
  text.replace(/^(?:یه|یک)\u200C?\s*/u, '').trimStart();

/**
 * True when the latest user turn is a clear request to produce a photo/image,
 * not a meta question about prompting or how image gen works.
 *
 * Used to force `tool_choice` onto `generateImage` so reasoning models cannot
 * answer by inventing a Stable-Diffusion-style plaintext prompt instead.
 */
export const isImageGenerationUserIntent = (text: string | null | undefined): boolean => {
  if (!text) return false;
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 4000) return false;
  if (META_QUESTION.test(trimmed)) return false;

  // "عکس …" / "یه عکس …" as the opening request is enough in Persian chat.
  const persianLead = stripPersianIndefinite(trimmed);
  if (persianLead.startsWith('عکس') || persianLead.startsWith('تصویر')) return true;

  if (ENGLISH_IMAGE_COMMAND.test(trimmed)) return true;

  return IMAGE_NOUN.test(trimmed) && GENERATE_VERB.test(trimmed);
};

export const extractPlainMessageText = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') {
        return part.text;
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
};

export const findLatestUserMessageText = (
  messages: Array<{ content?: unknown; role?: string }> | null | undefined,
): string => {
  if (!messages?.length) return '';
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role !== 'user') continue;
    const text = extractPlainMessageText(message.content);
    if (text.trim()) return text;
  }
  return '';
};

type ToolLike = { function?: { name?: string }; name?: string };

/**
 * When the catalog offers `generateImage`, return a Chat Completions
 * `tool_choice` that forces that function for the current turn.
 */
export const resolveForcedImageGenerationToolChoice = (
  tools: ToolLike[] | null | undefined,
): { function: { name: string }; type: 'function' } | undefined => {
  if (!tools?.length) return undefined;

  const match = tools.find((tool) => {
    const name = tool.function?.name ?? tool.name;
    return name === IMAGE_GENERATION_TOOL_FUNCTION_NAME;
  });
  const name = match?.function?.name ?? match?.name;
  if (!name) return undefined;

  return { function: { name }, type: 'function' };
};

export interface DirectGenerateImageToolCall {
  apiName: typeof ImageGenerationApiName.generateImage;
  arguments: string;
  executor?: 'client' | 'server';
  id: string;
  identifier: typeof ImageGenerationIdentifier;
  source?: 'builtin' | 'client' | 'mcp' | 'composio' | 'lobehubSkill';
  type: 'builtin';
}

/**
 * Build a one-shot `generateImage` tool call the same way Create → Image
 * would: the user's photo request is the prompt. Callers skip the LLM and
 * execute this payload when intent is clear.
 */
export const buildDirectGenerateImageToolCall = (params: {
  executor?: 'client' | 'server';
  prompt: string;
  source?: DirectGenerateImageToolCall['source'];
}): DirectGenerateImageToolCall => {
  const prompt = params.prompt.trim();
  const id =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? `call_${crypto.randomUUID()}`
      : `call_img_${Date.now().toString(36)}`;

  return {
    apiName: ImageGenerationApiName.generateImage,
    arguments: JSON.stringify({ prompt }),
    ...(params.executor ? { executor: params.executor } : {}),
    id,
    identifier: ImageGenerationIdentifier,
    ...(params.source ? { source: params.source } : {}),
    type: 'builtin',
  };
};

/**
 * When the latest user turn is a clear photo ask, return a Create-parity
 * direct `generateImage` tool call so the runtime skips the chat model.
 *
 * Do **not** gate on the tool being present in the current offer set: when
 * `generateImage` is missing (FC gap, stale client, custom toolMode), the
 * model answers with a plaintext promise ("Preparing image generation" /
 * "I'll make a cute cartoon…") and never produces a photo. Create → Image
 * never asks the LLM first — chat should match that for clear photo asks.
 */
export const resolveDirectImageGenerationToolCall = (params: {
  executorMap?: Record<string, 'client' | 'server' | undefined>;
  messages: Array<{ content?: unknown; role?: string }> | null | undefined;
  sourceMap?: Record<string, DirectGenerateImageToolCall['source'] | undefined>;
  /** @deprecated Ignored — kept so existing call sites keep compiling. */
  tools?: ToolLike[] | null | undefined;
}): DirectGenerateImageToolCall | undefined => {
  const prompt = findLatestUserMessageText(params.messages);
  if (!isImageGenerationUserIntent(prompt)) return undefined;

  return buildDirectGenerateImageToolCall({
    executor: params.executorMap?.[ImageGenerationIdentifier],
    prompt,
    source: params.sourceMap?.[ImageGenerationIdentifier] ?? 'builtin',
  });
};
