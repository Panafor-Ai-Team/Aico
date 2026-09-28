import { VideoGenerationApiName, VideoGenerationIdentifier } from './types';

/** OpenAI-style tool function name for `generateVideo`. */
export const VIDEO_GENERATION_TOOL_FUNCTION_NAME = `${VideoGenerationIdentifier}____${VideoGenerationApiName.generateVideo}`;

/**
 * Persian letters are not `\w`, so `\b` never matches next to them — Persian
 * alternatives below are matched without word boundaries.
 */
const META_QUESTION =
  /(?:^|\s)(?:how\s+(?:do|to|can|should)|what\s+is|چطور|چگونه|نحوه|write\s+(?:me\s+)?(?:a\s+)?prompt|پرامپت)/i;

/** Asks about an existing video (summarize / translate / transcribe) rather than making one. */
const EXISTING_VIDEO_TASK =
  /خلاصه|ترجمه|زیرنویس|تحلیل|summar|transcri|translat|subtitle|analy[sz]|download/i;

const PERSIAN_VIDEO_NOUN = /ویدیو|ویدئو|فیلم|کلیپ|انیمیشن/;

const PERSIAN_GENERATE_VERB = /بساز|درست\s*کن|تولید\s*کن|متحرک\s*کن/;

const ENGLISH_VIDEO_COMMAND =
  /\b(?:generate|create|make|render|produce|animate)\s+(?:me\s+)?(?:an?\s+|the\s+|this\s+|one\s+)?(?:short\s+|quick\s+|\d+[\s-]*(?:s|sec|second)s?\s+)?(?:video|clip|animation)\b/i;

const ENGLISH_VIDEO_LEAD = /^(?:an?\s+)?(?:short\s+)?(?:video|clip|animation)\s+of\b/i;

const ENGLISH_ANIMATE_IMAGE = /\banimate\s+(?:this|the|my|these)\s+(?:image|photo|picture)s?\b/i;

/**
 * True when the text is a clear request to produce a video — not a question
 * about prompting and not a task on an existing video.
 */
export const isVideoGenerationUserIntent = (text: string | null | undefined): boolean => {
  if (!text) return false;
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 4000) return false;
  if (META_QUESTION.test(trimmed) || EXISTING_VIDEO_TASK.test(trimmed)) return false;

  if (PERSIAN_VIDEO_NOUN.test(trimmed) && PERSIAN_GENERATE_VERB.test(trimmed)) return true;

  return (
    ENGLISH_VIDEO_COMMAND.test(trimmed) ||
    ENGLISH_VIDEO_LEAD.test(trimmed) ||
    ENGLISH_ANIMATE_IMAGE.test(trimmed)
  );
};

type MessageLike = { content?: unknown; role?: string };

const textOfContent = (content: unknown): string => {
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
 * The latest user turn, or `undefined` once a tool already answered it. The
 * context builder runs again after every tool result; without this guard the
 * same ask would trigger a fresh (billed) generation on each step.
 */
export const findPendingUserMessage = (
  messages: MessageLike[] | null | undefined,
): { imageUrls: string[]; text: string } | undefined => {
  if (!messages?.length) return undefined;

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role === 'tool') return undefined;
    if (message?.role !== 'user') continue;

    const text = textOfContent(message.content);
    if (!text.trim()) return undefined;
    return { imageUrls: imageUrlsOfContent(message.content), text };
  }

  return undefined;
};

export interface DirectGenerateVideoToolCall {
  apiName: typeof VideoGenerationApiName.generateVideo;
  arguments: string;
  executor?: 'client' | 'server';
  id: string;
  identifier: typeof VideoGenerationIdentifier;
  source?: 'builtin' | 'client' | 'mcp' | 'composio' | 'lobehubSkill';
  type: 'builtin';
}

export const buildDirectGenerateVideoToolCall = (params: {
  executor?: 'client' | 'server';
  imageUrls?: string[];
  prompt: string;
  source?: DirectGenerateVideoToolCall['source'];
}): DirectGenerateVideoToolCall => {
  const id =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? `call_${crypto.randomUUID()}`
      : `call_vid_${Date.now().toString(36)}`;

  return {
    apiName: VideoGenerationApiName.generateVideo,
    arguments: JSON.stringify({
      prompt: params.prompt.trim(),
      ...(params.imageUrls?.length ? { imageUrls: params.imageUrls } : {}),
    }),
    ...(params.executor ? { executor: params.executor } : {}),
    id,
    identifier: VideoGenerationIdentifier,
    ...(params.source ? { source: params.source } : {}),
    type: 'builtin',
  };
};

/**
 * When the latest user turn is a clear video ask, return a Create → Video
 * parity `generateVideo` call so the runtime skips the chat model, which would
 * otherwise answer with a text promise instead of producing a video. Images
 * attached to that turn are forwarded as reference frames.
 */
export const resolveDirectVideoGenerationToolCall = (params: {
  executorMap?: Record<string, 'client' | 'server' | undefined>;
  messages: MessageLike[] | null | undefined;
  sourceMap?: Record<string, DirectGenerateVideoToolCall['source'] | undefined>;
}): DirectGenerateVideoToolCall | undefined => {
  const pending = findPendingUserMessage(params.messages);
  if (!pending || !isVideoGenerationUserIntent(pending.text)) return undefined;

  return buildDirectGenerateVideoToolCall({
    executor: params.executorMap?.[VideoGenerationIdentifier],
    imageUrls: pending.imageUrls,
    prompt: pending.text,
    source: params.sourceMap?.[VideoGenerationIdentifier] ?? 'builtin',
  });
};
