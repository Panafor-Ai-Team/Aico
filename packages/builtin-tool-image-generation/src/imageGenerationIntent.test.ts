import { describe, expect, it } from 'vitest';

import {
  findLatestUserMessageText,
  IMAGE_GENERATION_TOOL_FUNCTION_NAME,
  isImageGenerationUserIntent,
  resolveForcedImageGenerationToolChoice,
} from './imageGenerationIntent';

describe('isImageGenerationUserIntent', () => {
  it('detects Persian photo requests that start with عکس', () => {
    expect(
      isImageGenerationUserIntent('عکس گورخری که مثل میمون از درخت آویزونه و یکی از چشماش چپه'),
    ).toBe(true);
    expect(isImageGenerationUserIntent('یه عکس از بتمن با علی دایی')).toBe(true);
  });

  it('detects English generate-image phrasings', () => {
    expect(isImageGenerationUserIntent('Generate an image of a red apple')).toBe(true);
    expect(isImageGenerationUserIntent('draw a picture of a cat')).toBe(true);
  });

  it('rejects meta / prompt-engineering questions', () => {
    expect(isImageGenerationUserIntent('چطور عکس بسازم؟')).toBe(false);
    expect(isImageGenerationUserIntent('write me a prompt for a zebra photo')).toBe(false);
    expect(isImageGenerationUserIntent('what is image generation')).toBe(false);
  });

  it('rejects ordinary chat without an image ask', () => {
    expect(isImageGenerationUserIntent('سلام')).toBe(false);
    expect(isImageGenerationUserIntent('explain photosynthesis')).toBe(false);
  });
});

describe('resolveForcedImageGenerationToolChoice', () => {
  it('returns a named tool_choice when generateImage is offered', () => {
    expect(
      resolveForcedImageGenerationToolChoice([
        { function: { name: 'lobe-web-browsing____search' } },
        { function: { name: IMAGE_GENERATION_TOOL_FUNCTION_NAME } },
      ]),
    ).toEqual({
      function: { name: IMAGE_GENERATION_TOOL_FUNCTION_NAME },
      type: 'function',
    });
  });

  it('returns nothing when the image tool is absent', () => {
    expect(
      resolveForcedImageGenerationToolChoice([
        { function: { name: 'lobe-web-browsing____search' } },
      ]),
    ).toBeUndefined();
  });
});

describe('findLatestUserMessageText', () => {
  it('reads the latest user turn, including multipart text parts', () => {
    expect(
      findLatestUserMessageText([
        { content: 'old', role: 'user' },
        { content: 'assistant', role: 'assistant' },
        { content: [{ text: 'عکس یک سگ', type: 'text' }], role: 'user' },
      ]),
    ).toBe('عکس یک سگ');
  });
});
