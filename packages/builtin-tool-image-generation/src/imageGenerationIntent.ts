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

// Must match the context-engine `SYSTEM_CONTEXT_START` / `SYSTEM_CONTEXT_END` markers and
// the vision-downgrade placeholder, which the chat pipeline appends to the user's own text.
const INJECTED_CONTEXT_BLOCK =
  /<!-- SYSTEM CONTEXT \(NOT PART OF USER QUERY\) -->[\s\S]*?(?:<!-- END SYSTEM CONTEXT -->|$)/g;
const VISION_DOWNGRADE_PLACEHOLDER = /\[image omitted: native vision is not supported\.[^\]]*\]/g;

type MessageLike = {
  content?: unknown;
  name?: string;
  plugin?: { apiName?: string; identifier?: string };
  role?: string;
};

const stripPersianIndefinite = (text: string) =>
  text.replace(/^(?:یه|یک)\u200C?\s*/u, '').trimStart();

/**
 * What the user typed, without file lists, selections or other context the
 * pipeline appended. Intent detection must not see injected "how to" / "what is"
 * copy or a ballooned length from SYSTEM CONTEXT.
 */
export const stripInjectedUserContext = (text: string) =>
  text.replaceAll(INJECTED_CONTEXT_BLOCK, '').replaceAll(VISION_DOWNGRADE_PLACEHOLDER, '').trim();

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

/**
 * True when a tool message is a `generateImage` result (OpenAI `name` after
 * ToolCallProcessor, or DB-shape `plugin` before cleanup).
 */
const isImageGenerationToolResult = (message: MessageLike): boolean => {
  if (message.role !== 'tool') return false;

  const name = typeof message.name === 'string' ? message.name : '';
  if (name === IMAGE_GENERATION_TOOL_FUNCTION_NAME) return true;
  if (
    name.includes(ImageGenerationIdentifier) &&
    name.includes(ImageGenerationApiName.generateImage)
  ) {
    return true;
  }

  return (
    message.plugin?.identifier === ImageGenerationIdentifier &&
    message.plugin?.apiName === ImageGenerationApiName.generateImage
  );
};

const hasImageGenerationToolResultAfter = (messages: MessageLike[], userIndex: number): boolean => {
  for (let i = userIndex + 1; i < messages.length; i += 1) {
    if (isImageGenerationToolResult(messages[i]!)) return true;
  }
  return false;
};

/**
 * The latest user turn's text (pipeline injections stripped), or `''` once
 * `generateImage` already answered that turn. The context builder runs again
 * after every tool result; without this guard the same photo ask would trigger
 * a fresh (billed) generation on each step.
 *
 * Only an image-generation tool result after the latest user counts as
 * "answered". Unrelated trailing tools (onboarding synthetic state, local-system
 * snapshots) must not block a clear photo ask.
 */
export const findPendingUserMessageText = (messages: MessageLike[] | null | undefined): string => {
  if (!messages?.length) return '';

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role !== 'user') continue;

    if (hasImageGenerationToolResultAfter(messages, i)) return '';

    return stripInjectedUserContext(extractPlainMessageText(message.content));
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
  messages: MessageLike[] | null | undefined;
  sourceMap?: Record<string, DirectGenerateImageToolCall['source'] | undefined>;
  /** @deprecated Ignored — kept so existing call sites keep compiling. */
  tools?: ToolLike[] | null | undefined;
}): DirectGenerateImageToolCall | undefined => {
  const prompt = findPendingUserMessageText(params.messages);
  if (!isImageGenerationUserIntent(prompt)) return undefined;

  return buildDirectGenerateImageToolCall({
    executor: params.executorMap?.[ImageGenerationIdentifier],
    prompt,
    source: params.sourceMap?.[ImageGenerationIdentifier] ?? 'builtin',
  });
};
