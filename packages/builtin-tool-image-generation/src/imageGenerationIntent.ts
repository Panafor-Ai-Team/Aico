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
