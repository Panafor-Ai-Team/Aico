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
  /خلاصه|ترجمه|زیرنویس|تحلیل|توضیح|ببین|نگاه|summar|transcri|translat|subtitle|analy[sz]|download|explain|describe|watch/i;

/**
 * Web/code animation briefs ("logo animation in HTML/CSS/JS", "create with code
 * not video tool"). These often contain "make the animation" / "create …
 * animation" and must not trip the video tool offer or direct-call path.
 *
 * Paired with {@link HAS_VIDEO_OR_CLIP_NOUN}: code signals alone reject only when
 * the user did not also name a real video/clip (so "video tutorial about HTML"
 * still matches).
 */
const CODE_OR_WEB_ANIMATION =
  /\b(?:html|css|javascript|typescript|svg|react|framer[\s-]?motion|gpu-friendly|run(?:nable|s)?\s+(?:immediately\s+)?(?:in\s+the\s+)?browser|single\s+runnable|web\s+animation|css\s+transforms?)\b/i;

const HAS_VIDEO_OR_CLIP_NOUN = /\b(?:video|clip)s?\b|ویدیو|ویدئو|فیلم|کلیپ/i;

const EXPLICIT_NOT_VIDEO =
  /\b(?:not\s+(?:a\s+)?video(?:\s+tool)?|code\s+not\s+video|with\s+code\s*(?:,\s*)?not\s+video)\b|بدون\s+(?:ویدیو|ویدئو)|(?:کد\s+)?نه\s+(?:ویدیو|ویدئو)/i;

const PERSIAN_VIDEO_NOUN = /ویدیو|ویدئو|فیلم|کلیپ|انیمیشن/;

const PERSIAN_GENERATE_VERB =
  /بساز|(?:می|ب)[\s\u200C]?سازی|ساخت|درست\s*کن|تولید|ایجاد|متحرک\s*کن|(?:می|ب)[\s\u200C]?خوا[مه]/;

const ENGLISH_VIDEO_COMMAND =
  /\b(?:generate|create|make|render|produce|animate)\s+(?:me\s+)?(?:an?\s+|the\s+|this\s+|one\s+)?(?:short\s+|quick\s+|\d+[\s-]*(?:s|sec|second)s?\s+)?(?:video|clip|animation)\b/i;

const ENGLISH_VIDEO_LEAD = /^(?:an?\s+)?(?:short\s+)?(?:video|clip|animation)\s+of\b/i;

const ENGLISH_ANIMATE_IMAGE = /\banimate\s+(?:this|the|my|these)\s+(?:image|photo|picture)s?\b/i;

const NUMBER_WORDS: Record<string, number> = {
  بیست: 20,
  پانزده: 15,
  پنج: 5,
  پونزده: 15,
  چهار: 4,
  چهارده: 14,
  دو: 2,
  دوازده: 12,
  ده: 10,
  eight: 8,
  eleven: 11,
  fifteen: 15,
  five: 5,
  four: 4,
  fourteen: 14,
  nine: 9,
  one: 1,
  سه: 3,
  سی: 30,
  سیزده: 13,
  seven: 7,
  شش: 6,
  شیش: 6,
  six: 6,
  ten: 10,
  thirteen: 13,
  thirty: 30,
  three: 3,
  twelve: 12,
  twenty: 20,
  two: 2,
  نه: 9,
  هشت: 8,
  هفت: 7,
  یازده: 11,
  یک: 1,
  یه: 1,
};

// Longest first so «یازده» is not read as «ده».
const NUMBER_WORD_PATTERN = Object.keys(NUMBER_WORDS)
  .sort((a, b) => b.length - a.length)
  .join('|');

const DURATION_PATTERN = new RegExp(
  String.raw`(?<![\p{L}\d.])(\d+(?:\.\d+)?|${NUMBER_WORD_PATTERN})[\s\u200C-]*(ثانیه|دقیقه|seconds?|secs?|minutes?|mins?|s(?![\p{L}]))`,
  'iu',
);

const toLatinDigits = (text: string) =>
  text
    .replaceAll(/[\u06F0-\u06F9]/g, (digit) => String(digit.codePointAt(0)! - 0x06_f0))
    .replaceAll(/[\u0660-\u0669]/g, (digit) => String(digit.codePointAt(0)! - 0x06_60));

/**
 * The video length the user asked for, in seconds («۲ ثانیه», «دو ثانیه»,
 * "2-second", "5s", "1 minute"), or `undefined` when none is given.
 */
export const extractRequestedVideoDuration = (text: string | null | undefined) => {
  if (!text) return undefined;

  const match = toLatinDigits(text).match(DURATION_PATTERN);
  if (!match) return undefined;

  const amount = NUMBER_WORDS[match[1].toLowerCase()] ?? Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return undefined;
  // A bare `s` on a large number is a decade or plural ("1990s"), not a length.
  if (match[2].toLowerCase() === 's' && amount > 60) return undefined;

  return /^(?:دقیقه|min)/i.test(match[2]) ? amount * 60 : amount;
};

const RESOLUTION_PATTERN =
  /(?<!\d)(360|480|540|720|1080|1440|2160)[\s\u200C]*(?:p|پی(?:کسل)?)(?!\p{L})/iu;

// «کیفیتش 480 باشه», «کیفیت ویدیو ۴۸۰», "quality of 480" — a few words may sit in between.
const QUALITY_WORD_RESOLUTION_PATTERN =
  /(?:کیفیت|رزولوشن|quality|resolution)[^\d\n]{0,16}(360|480|540|720|1080|1440|2160)(?!\d)/iu;

/** The output quality the user asked for («کیفیت ۴۸۰», "720p"), as a `…p` resolution. */
export const extractRequestedVideoResolution = (text: string | null | undefined) => {
  if (!text) return undefined;

  const normalized = toLatinDigits(text);
  const match =
    normalized.match(RESOLUTION_PATTERN) ?? normalized.match(QUALITY_WORD_RESOLUTION_PATTERN);
  if (match) return `${match[1]}p`;
  if (/(?<!\p{L})4k(?!\p{L})/iu.test(normalized)) return '2160p';
  return undefined;
};

const ASPECT_RATIO_PATTERN = /(?<![\d.])(21|16|[91-4])\s*[:：]\s*([934]|16|21|[21])(?![\d.])/;

// English words only count next to a format noun: "a portrait of a woman" is content.
const ASPECT_RATIO_WORDS: Array<[RegExp, string]> = [
  [/عمودی|\b(?:vertical|portrait)\s+(?:video|clip|format|mode)\b/i, '9:16'],
  [/افقی|\b(?:horizontal|landscape)\s+(?:video|clip|format|mode)\b/i, '16:9'],
  [/مربعی|\bsquare\s+(?:video|clip|format)\b/i, '1:1'],
];

/** The frame shape the user asked for ("9:16", «عمودی», "square"). */
export const extractRequestedVideoAspectRatio = (text: string | null | undefined) => {
  if (!text) return undefined;

  const match = toLatinDigits(text).match(ASPECT_RATIO_PATTERN);
  if (match) return `${match[1]}:${match[2]}`;
  return ASPECT_RATIO_WORDS.find(([pattern]) => pattern.test(text))?.[1];
};

/**
 * True when the text is a clear request to produce a video — not a question
 * about prompting, not a task on an existing video, and not a web/code
 * animation brief (HTML/CSS/JS logo intros, etc.).
 */
export const isVideoGenerationUserIntent = (text: string | null | undefined): boolean => {
  if (!text) return false;
  // Pipeline may append SYSTEM CONTEXT; intent must use the user's own words.
  const trimmed = stripInjectedUserContext(text.trim());
  if (!trimmed || trimmed.length > 4000) return false;
  if (
    META_QUESTION.test(trimmed) ||
    EXISTING_VIDEO_TASK.test(trimmed) ||
    EXPLICIT_NOT_VIDEO.test(trimmed)
  ) {
    return false;
  }
  // Logo/web animation specs say "make the animation" + HTML/CSS/JS; reject those
  // unless the user also asked for a video/clip output.
  if (CODE_OR_WEB_ANIMATION.test(trimmed) && !HAS_VIDEO_OR_CLIP_NOUN.test(trimmed)) {
    return false;
  }

  if (PERSIAN_VIDEO_NOUN.test(trimmed)) {
    if (PERSIAN_GENERATE_VERB.test(trimmed)) return true;
    // «یه ویدیو ۲ ثانیه‌ای با کیفیت ۴۸۰ از …» names the output without a verb.
    if (extractRequestedVideoDuration(trimmed) || extractRequestedVideoResolution(trimmed)) {
      return true;
    }
  }

  return (
    ENGLISH_VIDEO_COMMAND.test(trimmed) ||
    ENGLISH_VIDEO_LEAD.test(trimmed) ||
    ENGLISH_ANIMATE_IMAGE.test(trimmed)
  );
};

type MessageLike = {
  content?: unknown;
  name?: string;
  plugin?: { apiName?: string; identifier?: string };
  role?: string;
};

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

// Must match the context-engine `SYSTEM_CONTEXT_START` / `SYSTEM_CONTEXT_END` markers and
// the vision-downgrade placeholder, which the chat pipeline appends to the user's own text.
const INJECTED_CONTEXT_BLOCK =
  /<!-- SYSTEM CONTEXT \(NOT PART OF USER QUERY\) -->[\s\S]*?(?:<!-- END SYSTEM CONTEXT -->|$)/g;
const VISION_DOWNGRADE_PLACEHOLDER = /\[image omitted: native vision is not supported\.[^\]]*\]/g;

/** What the user typed, without file lists, selections or other context the pipeline appended. */
export const stripInjectedUserContext = (text: string) =>
  text.replaceAll(INJECTED_CONTEXT_BLOCK, '').replaceAll(VISION_DOWNGRADE_PLACEHOLDER, '').trim();

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

const FILE_CONTEXT_IMAGE_URL = /<image\s[^>]*?\burl="(https?:\/\/[^"]+)"/g;

/**
 * Attached images as listed in the pipeline's `<files_info>` block — the only
 * place they appear when the chat model has no vision and gets no image parts.
 */
const imageUrlsOfInjectedContext = (text: string): string[] =>
  (text.match(INJECTED_CONTEXT_BLOCK) ?? []).flatMap((block) =>
    [...block.matchAll(FILE_CONTEXT_IMAGE_URL)].map((match) => match[1]),
  );

/**
 * True when a tool message is a `generateVideo` result (OpenAI `name` after
 * ToolCallProcessor, or DB-shape `plugin` before cleanup).
 */
const isVideoGenerationToolResult = (message: MessageLike): boolean => {
  if (message.role !== 'tool') return false;

  const name = typeof message.name === 'string' ? message.name : '';
  if (name === VIDEO_GENERATION_TOOL_FUNCTION_NAME) return true;
  if (
    name.includes(VideoGenerationIdentifier) &&
    name.includes(VideoGenerationApiName.generateVideo)
  ) {
    return true;
  }

  return (
    message.plugin?.identifier === VideoGenerationIdentifier &&
    message.plugin?.apiName === VideoGenerationApiName.generateVideo
  );
};

const hasVideoGenerationToolResultAfter = (messages: MessageLike[], userIndex: number): boolean => {
  for (let i = userIndex + 1; i < messages.length; i += 1) {
    if (isVideoGenerationToolResult(messages[i]!)) return true;
  }
  return false;
};

/**
 * The latest user turn, or `undefined` once `generateVideo` already answered
 * that turn. The context builder runs again after every tool result; without
 * this guard the same ask would trigger a fresh (billed) generation on each
 * step.
 *
 * Only a video-generation tool result after the latest user counts as
 * "answered". Unrelated trailing tools (onboarding synthetic state,
 * local-system snapshots) must not block a clear video ask.
 */
export const findPendingUserMessage = (
  messages: MessageLike[] | null | undefined,
): { imageUrls: string[]; text: string } | undefined => {
  if (!messages?.length) return undefined;

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role !== 'user') continue;

    if (hasVideoGenerationToolResultAfter(messages, i)) return undefined;

    const rawText = textOfContent(message.content);
    const text = stripInjectedUserContext(rawText);
    if (!text) return undefined;

    const imageUrls = [
      ...new Set([...imageUrlsOfContent(message.content), ...imageUrlsOfInjectedContext(rawText)]),
    ];
    return { imageUrls, text };
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
  aspectRatio?: string;
  duration?: number;
  executor?: 'client' | 'server';
  imageUrls?: string[];
  prompt: string;
  resolution?: string;
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
      ...(params.aspectRatio ? { aspectRatio: params.aspectRatio } : {}),
      ...(params.duration ? { duration: params.duration } : {}),
      ...(params.imageUrls?.length ? { imageUrls: params.imageUrls } : {}),
      ...(params.resolution ? { resolution: params.resolution } : {}),
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
    aspectRatio: extractRequestedVideoAspectRatio(pending.text),
    duration: extractRequestedVideoDuration(pending.text),
    resolution: extractRequestedVideoResolution(pending.text),
    executor: params.executorMap?.[VideoGenerationIdentifier],
    imageUrls: pending.imageUrls,
    prompt: pending.text,
    source: params.sourceMap?.[VideoGenerationIdentifier] ?? 'builtin',
  });
};
