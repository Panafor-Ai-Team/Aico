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

/**
 * Follow-up photo asks after a prior generation in the same chat. These often
 * omit an explicit image noun ("another one", «یکی دیگه بساز») so the plain
 * detector misses them and the LLM answers with a text promise instead.
 */
const ANOTHER_IMAGE_ASK =
  /\b(?:another|one more)\s+(?:image|picture|photo|one)\b|\b(?:image|picture|photo)\s+again\b|\banother one\b|\b(?:make|create|generate|draw)\s+(?:me\s+)?(?:another|one more)\b|یکی\s*دیگه|یه\s*دونه\s*دیگه|بازم(?:\s*(?:بساز|بکش|بده|عکس|تصویر))?|دوباره\s*(?:عکس|تصویر|بساز|بکش)/i;

/**
 * Pronoun-only edit asks ("change it", «همونو عوضش کن») that name no image.
 * Only trusted right after a turn that generated an image — otherwise "fix it"
 * on a code answer would start a billed generation.
 */
const ANAPHORIC_IMAGE_EDIT =
  /عوضش\s*کن|عوض\s*کن|تغییرش\s*بده|تغییر\s*بده|درستش\s*کن|بهترش\s*کن|ویرایشش\s*کن|همونو|همینو|همین\s*رو|اینو\s*(?:عوض|تغییر|درست|ویرایش)|یه\s*جور\s*دیگه|یه\s*مدل\s*دیگه|سبک\s*دیگه|متفاوت\s*(?:بساز|کن)|\b(?:change|edit|modify|redo|regenerate|tweak)\s+(?:it|that|this)\b|\btry\s+again\b|\bdifferent\s+(?:style|version|look)\b/i;

/**
 * Edit / continuation asks that depend on a prior image (user-attached or
 * previously generated in this chat). Without this, phrases like "add a bird
 * to the previous image" never match the photo-ask detector and the direct
 * path cannot forward a reference URL.
 */
const IMAGE_EDIT_CONTINUATION =
  /\b(?:previous|last|above|that|same|earlier)\s+(?:image|picture|photo|one)\b|\b(?:add|remove|replace|change|edit|modify|update|keep)\b.{1,80}\b(?:image|picture|photo|drawing|illustration)\b|(?:تصویر|عکس)\s*قبلی|همون\s*(?:عکس|تصویر)|بهش\s*اضافه|ویرایش\s*کن|تغییر\s*بده/i;

// Must match the context-engine `SYSTEM_CONTEXT_START` / `SYSTEM_CONTEXT_END` markers and
// the vision-downgrade placeholder, which the chat pipeline appends to the user's own text.
const INJECTED_CONTEXT_BLOCK =
  /<!-- SYSTEM CONTEXT \(NOT PART OF USER QUERY\) -->[\s\S]*?(?:<!-- END SYSTEM CONTEXT -->|$)/g;
const VISION_DOWNGRADE_PLACEHOLDER = /\[image omitted: native vision is not supported\.[^\]]*\]/g;

const MARKDOWN_IMAGE_URL = /!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g;
const IMAGE_URL_LINE = /(?:^|\n)(?:Image URL|imageUrl)\s*[:=]\s*(https?:\/\/\S+)/gi;
const FILE_CONTEXT_IMAGE_URL = /<image\s[^>]*?\burl="(https?:\/\/[^"]+)"/g;

type PluginStateLike = {
  generations?: Array<{
    asset?: { originalUrl?: string; thumbnailUrl?: string; url?: string } | null;
  }>;
};

type NestedToolLike = {
  apiName?: string;
  identifier?: string;
  result?: {
    content?: unknown;
    state?: PluginStateLike;
  } | null;
};

type MessageLike = {
  children?: Array<{ tools?: NestedToolLike[] | null } | null> | null;
  content?: unknown;
  name?: string;
  plugin?: { apiName?: string; identifier?: string };
  pluginState?: PluginStateLike;
  role?: string;
  tools?: NestedToolLike[] | null;
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

/** True when the ask clearly edits / continues from a prior image. */
export const isImageEditContinuationIntent = (text: string | null | undefined): boolean => {
  if (!text) return false;
  return IMAGE_EDIT_CONTINUATION.test(text.trim());
};

/** True for pronoun-only edit asks ("change it", «همونو عوضش کن»). */
export const isAnaphoricImageEditIntent = (text: string | null | undefined): boolean => {
  if (!text) return false;
  return ANAPHORIC_IMAGE_EDIT.test(text.trim());
};

/** True when the ask is a follow-up "another photo" after a prior generation. */
export const isAnotherImageAskIntent = (text: string | null | undefined): boolean => {
  if (!text) return false;
  return ANOTHER_IMAGE_ASK.test(text.trim());
};

/**
 * True when the latest user turn is a clear request to produce a photo/image,
 * not a meta question about prompting or how image gen works.
 *
 * Used to force `tool_choice` onto `generateImage` so reasoning models cannot
 * answer by inventing a Stable-Diffusion-style plaintext prompt instead.
 *
 * Pass `hasPreviousGenerated` so soft follow-ups ("another one", «یکی دیگه»)
 * after a successful generation still take the direct path.
 */
export const isImageGenerationUserIntent = (
  text: string | null | undefined,
  options?: { hasPreviousGenerated?: boolean; previousTurnGeneratedImage?: boolean },
): boolean => {
  if (!text) return false;
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 4000) return false;
  if (META_QUESTION.test(trimmed)) return false;

  // "عکس …" / "یه عکس …" as the opening request is enough in Persian chat.
  const persianLead = stripPersianIndefinite(trimmed);
  if (persianLead.startsWith('عکس') || persianLead.startsWith('تصویر')) return true;

  if (ENGLISH_IMAGE_COMMAND.test(trimmed)) return true;
  if (isImageEditContinuationIntent(trimmed)) return true;
  if (options?.hasPreviousGenerated && isAnotherImageAskIntent(trimmed)) return true;
  if (options?.previousTurnGeneratedImage && isAnaphoricImageEditIntent(trimmed)) return true;

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

const isGenerateImageToolRef = (tool: {
  apiName?: string;
  identifier?: string;
  name?: string;
}): boolean => {
  const name = typeof tool.name === 'string' ? tool.name : '';
  if (name === IMAGE_GENERATION_TOOL_FUNCTION_NAME) return true;
  if (
    name.includes(ImageGenerationIdentifier) &&
    name.includes(ImageGenerationApiName.generateImage)
  ) {
    return true;
  }

  return (
    tool.identifier === ImageGenerationIdentifier &&
    tool.apiName === ImageGenerationApiName.generateImage
  );
};

/**
 * True when a tool message is a `generateImage` result (OpenAI `name` after
 * ToolCallProcessor, or DB-shape `plugin` before cleanup).
 */
const isImageGenerationToolResult = (message: MessageLike): boolean => {
  if (message.role !== 'tool') return false;

  return isGenerateImageToolRef({
    apiName: message.plugin?.apiName,
    identifier: message.plugin?.identifier,
    name: typeof message.name === 'string' ? message.name : undefined,
  });
};

/**
 * Display transcripts nest completed tools under `assistantGroup.children[].tools`
 * (with `result`). The pending-ask guard must see those too — otherwise resolving
 * against raw display messages re-fires the first ask, and callers that only pass
 * prepared flat rows miss the opposite failure mode when flatten/cleanup drops identity.
 */
const nestedImageGenerationResults = (message: MessageLike): NestedToolLike[] => {
  const tools: NestedToolLike[] = [];

  if (Array.isArray(message.tools)) {
    for (const tool of message.tools) {
      if (tool) tools.push(tool);
    }
  }

  if (Array.isArray(message.children)) {
    for (const child of message.children) {
      if (!Array.isArray(child?.tools)) continue;
      for (const tool of child.tools) {
        if (tool) tools.push(tool);
      }
    }
  }

  return tools.filter(
    (tool) => isGenerateImageToolRef(tool) && tool.result != null && tool.result !== undefined,
  );
};

const messageHasImageGenerationResult = (message: MessageLike): boolean =>
  isImageGenerationToolResult(message) || nestedImageGenerationResults(message).length > 0;

const hasImageGenerationToolResultAfter = (messages: MessageLike[], userIndex: number): boolean => {
  for (let i = userIndex + 1; i < messages.length; i += 1) {
    if (messageHasImageGenerationResult(messages[i]!)) return true;
  }
  return false;
};

/**
 * True when the turn right before the latest user message produced an image
 * (between the previous user message and the latest one).
 */
export const didPreviousTurnGenerateImage = (
  messages: MessageLike[] | null | undefined,
): boolean => {
  if (!messages?.length) return false;

  const lastUser = messages.findLastIndex((message) => message?.role === 'user');
  if (lastUser <= 0) return false;

  for (let i = lastUser - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    if (message.role === 'user') return false;
    if (messageHasImageGenerationResult(message)) return true;
  }
  return false;
};

/** True when this conversation already completed at least one generateImage call. */
export const hasPreviousImageGeneration = (messages: MessageLike[] | null | undefined): boolean => {
  if (!messages?.length) return false;
  return messages.some((message) => messageHasImageGenerationResult(message));
};

/** Only fetchable URLs — data URIs are too large to forward as generation params. */
const imageUrlsOfContent = (content: unknown): string[] => {
  if (!Array.isArray(content)) return [];

  return content
    .map((part) => {
      if (!part || typeof part !== 'object' || !('image_url' in part)) return;
      const imageUrl = (part as { image_url?: { url?: unknown } | string }).image_url;
      const url = typeof imageUrl === 'string' ? imageUrl : imageUrl?.url;
      return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : undefined;
    })
    .filter((url): url is string => Boolean(url));
};

/**
 * Attached images as listed in the pipeline's `<files_info>` block — the only
 * place they appear when the chat model has no vision and gets no image parts.
 */
const imageUrlsOfInjectedContext = (text: string): string[] =>
  (text.match(INJECTED_CONTEXT_BLOCK) ?? []).flatMap((block) =>
    [...block.matchAll(FILE_CONTEXT_IMAGE_URL)].map((match) => match[1]),
  );

const imageUrlsFromText = (text: string): string[] => {
  const urls: string[] = [];
  for (const match of text.matchAll(MARKDOWN_IMAGE_URL)) {
    if (match[1]) urls.push(match[1]);
  }
  for (const match of text.matchAll(IMAGE_URL_LINE)) {
    if (match[1]) urls.push(match[1].replace(/[.,;:!?)]+$/, ''));
  }
  return urls;
};

const imageUrlsFromPluginStateLike = (state: PluginStateLike | null | undefined): string[] => {
  const generations = state?.generations;
  if (!Array.isArray(generations)) return [];

  return generations
    .map((item) => item.asset?.url || item.asset?.originalUrl || item.asset?.thumbnailUrl)
    .filter((url): url is string => typeof url === 'string' && /^https?:\/\//i.test(url));
};

const imageUrlsFromPluginState = (message: MessageLike): string[] =>
  imageUrlsFromPluginStateLike(message.pluginState);

const imageUrlsFromNestedTool = (tool: NestedToolLike): string[] => [
  ...imageUrlsFromPluginStateLike(tool.result?.state),
  ...imageUrlsFromText(extractPlainMessageText(tool.result?.content)),
];

/**
 * Latest completed `generateImage` result URLs in this conversation, newest
 * batch first. Used so edit follow-ups can pass the prior image as a reference.
 * Understands both flat OpenAI tool rows and nested `assistantGroup` tools.
 */
export const findLatestGeneratedImageUrls = (
  messages: MessageLike[] | null | undefined,
): string[] => {
  if (!messages?.length) return [];

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message) continue;

    if (isImageGenerationToolResult(message)) {
      const urls = [
        ...new Set([
          ...imageUrlsFromPluginState(message),
          ...imageUrlsFromText(extractPlainMessageText(message.content)),
        ]),
      ];
      if (urls.length > 0) return urls;
      continue;
    }

    const nested = nestedImageGenerationResults(message);
    for (let j = nested.length - 1; j >= 0; j -= 1) {
      const urls = [...new Set(imageUrlsFromNestedTool(nested[j]!))];
      if (urls.length > 0) return urls;
    }
  }

  return [];
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
  return findPendingUserMessage(messages)?.text ?? '';
};

/**
 * Latest unanswered user turn, with attachment URLs from that turn (multipart
 * image parts or `<files_info>` in SYSTEM CONTEXT).
 */
export const findPendingUserMessage = (
  messages: MessageLike[] | null | undefined,
): { imageUrls: string[]; text: string } | undefined => {
  if (!messages?.length) return undefined;

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role !== 'user') continue;

    if (hasImageGenerationToolResultAfter(messages, i)) return undefined;

    const rawText = extractPlainMessageText(message.content);
    const text = stripInjectedUserContext(rawText);
    if (!text) return undefined;

    const imageUrls = [
      ...new Set([...imageUrlsOfContent(message.content), ...imageUrlsOfInjectedContext(rawText)]),
    ];
    return { imageUrls, text };
  }

  return undefined;
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
  imageUrls?: string[];
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
    arguments: JSON.stringify({
      prompt,
      ...(params.imageUrls?.length ? { imageUrls: params.imageUrls } : {}),
    }),
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
 *
 * Attachments on the current turn are forwarded as reference images. Edit
 * follow-ups that refer to a previous image reuse the latest generateImage
 * result URL so "add a bird to the previous image" is image-to-image, not a
 * blind text-to-image regen.
 */
export const resolveDirectImageGenerationToolCall = (params: {
  executorMap?: Record<string, 'client' | 'server' | undefined>;
  /**
   * Optional raw display transcript (assistantGroup / pluginState). When set,
   * pending-ask detection prefers it so pipeline injectors on prepared rows
   * cannot hide a second clear photo ask, and prior URLs can be mined from
   * nested tool results MessageCleanup would strip.
   */
  historyMessages?: MessageLike[] | null;
  messages: MessageLike[] | null | undefined;
  sourceMap?: Record<string, DirectGenerateImageToolCall['source'] | undefined>;
  /** @deprecated Ignored — kept so existing call sites keep compiling. */
  tools?: ToolLike[] | null | undefined;
}): DirectGenerateImageToolCall | undefined => {
  // Prefer the raw display transcript for "is there an unanswered photo ask?":
  // prepared OpenAI rows may carry onboarding/local-system tools after the user
  // and SYSTEM CONTEXT on the text. When the raw transcript has a user turn it
  // is authoritative — falling back to prepared rows after it says "answered"
  // could re-fire (and re-bill) the same ask.
  const historyHasUser = params.historyMessages?.some((message) => message?.role === 'user');
  const history = historyHasUser ? params.historyMessages! : params.messages;
  const pending = findPendingUserMessage(history);
  if (!pending) return undefined;

  const previousGeneratedUrls = findLatestGeneratedImageUrls(history);
  const hasPreviousGenerated =
    previousGeneratedUrls.length > 0 || hasPreviousImageGeneration(history);
  const previousTurnGeneratedImage = didPreviousTurnGenerateImage(history);

  if (
    !isImageGenerationUserIntent(pending.text, { hasPreviousGenerated, previousTurnGeneratedImage })
  ) {
    return undefined;
  }

  const isEdit =
    isImageEditContinuationIntent(pending.text) ||
    (previousTurnGeneratedImage && isAnaphoricImageEditIntent(pending.text));
  const imageUrls =
    pending.imageUrls.length > 0 ? pending.imageUrls : isEdit ? previousGeneratedUrls : [];

  return buildDirectGenerateImageToolCall({
    executor: params.executorMap?.[ImageGenerationIdentifier],
    ...(imageUrls.length ? { imageUrls } : {}),
    prompt: pending.text,
    source: params.sourceMap?.[ImageGenerationIdentifier] ?? 'builtin',
  });
};
