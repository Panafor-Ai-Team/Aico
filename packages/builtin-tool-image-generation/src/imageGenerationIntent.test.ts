import { describe, expect, it } from 'vitest';

import {
  findLatestUserMessageText,
  findPendingUserMessageText,
  IMAGE_GENERATION_TOOL_FUNCTION_NAME,
  isImageGenerationUserIntent,
  resolveDirectImageGenerationToolCall,
  resolveForcedImageGenerationToolChoice,
} from './imageGenerationIntent';

const imageGenToolResult = {
  content: 'Image generation completed with gpt-image-2.',
  name: IMAGE_GENERATION_TOOL_FUNCTION_NAME,
  role: 'tool' as const,
};

const pollutedSystemContext = `<!-- SYSTEM CONTEXT (NOT PART OF USER QUERY) -->
<context.instruction>following part contains context information injected by the system. Please follow these instructions:
1. Always prioritize handling user-visible content.
2. the context is only required when user's queries rely on it.
</context.instruction>
<docs>what is image generation and how to write me a prompt for photos: ${'x'.repeat(4100)}</docs>
<!-- END SYSTEM CONTEXT -->`;

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

describe('resolveDirectImageGenerationToolCall', () => {
  it('builds a generateImage call from a clear Persian photo ask', () => {
    const call = resolveDirectImageGenerationToolCall({
      messages: [
        {
          content: 'عکس گورخری که مثل میمون از درخت آویزونه و یکی از چشماش چپه',
          role: 'user',
        },
      ],
      tools: [{ function: { name: IMAGE_GENERATION_TOOL_FUNCTION_NAME } }],
    });

    expect(call).toMatchObject({
      apiName: 'generateImage',
      identifier: 'lobe-image-generation',
      type: 'builtin',
    });
    expect(JSON.parse(call!.arguments)).toEqual({
      prompt: 'عکس گورخری که مثل میمون از درخت آویزونه و یکی از چشماش چپه',
    });
  });

  it('still builds a direct call when the photo tool is missing from the offer set', () => {
    const call = resolveDirectImageGenerationToolCall({
      messages: [{ content: 'Generate an image of a cat', role: 'user' }],
      tools: [{ function: { name: 'lobe-web-browsing____search' } }],
    });

    expect(call).toMatchObject({
      apiName: 'generateImage',
      identifier: 'lobe-image-generation',
    });
    expect(JSON.parse(call!.arguments)).toEqual({
      prompt: 'Generate an image of a cat',
    });
  });

  it('returns nothing for ordinary chat', () => {
    expect(
      resolveDirectImageGenerationToolCall({
        messages: [{ content: 'سلام', role: 'user' }],
        tools: [{ function: { name: IMAGE_GENERATION_TOOL_FUNCTION_NAME } }],
      }),
    ).toBeUndefined();
  });

  it('does not fire again once generateImage already answered the ask', () => {
    expect(
      resolveDirectImageGenerationToolCall({
        messages: [
          { content: 'Generate an image of a cat', role: 'user' },
          { content: '', role: 'assistant' },
          imageGenToolResult,
        ],
      }),
    ).toBeUndefined();
  });

  it('fires again for a second clear photo ask after a prior generation', () => {
    const call = resolveDirectImageGenerationToolCall({
      messages: [
        { content: 'Generate an image of a cat', role: 'user' },
        { content: '', role: 'assistant' },
        imageGenToolResult,
        { content: 'Here is your cat.', role: 'assistant' },
        { content: 'Generate an image of a dog', role: 'user' },
      ],
    });

    expect(call).toMatchObject({
      apiName: 'generateImage',
      identifier: 'lobe-image-generation',
    });
    expect(JSON.parse(call!.arguments)).toEqual({
      prompt: 'Generate an image of a dog',
    });
  });

  it('still fires when SYSTEM CONTEXT would trip meta / length checks on the raw text', () => {
    const call = resolveDirectImageGenerationToolCall({
      messages: [
        {
          content: `عکس یک سگ\n\n${pollutedSystemContext}`,
          role: 'user',
        },
      ],
    });

    expect(call).toMatchObject({
      apiName: 'generateImage',
      identifier: 'lobe-image-generation',
    });
    expect(JSON.parse(call!.arguments)).toEqual({ prompt: 'عکس یک سگ' });
  });

  it('still fires when an unrelated trailing tool follows the photo ask', () => {
    const call = resolveDirectImageGenerationToolCall({
      messages: [
        { content: 'Generate an image of a cat', role: 'user' },
        { content: '', role: 'assistant' },
        {
          content: '{"phase":"Discovery"}',
          name: 'lobe-web-onboarding____getOnboardingState',
          role: 'tool',
        },
      ],
    });

    expect(call).toMatchObject({
      apiName: 'generateImage',
      identifier: 'lobe-image-generation',
    });
    expect(JSON.parse(call!.arguments)).toEqual({
      prompt: 'Generate an image of a cat',
    });
  });
});

describe('findPendingUserMessageText', () => {
  it('returns the latest user text while no image tool has answered it', () => {
    expect(
      findPendingUserMessageText([
        { content: 'old', role: 'user' },
        { content: 'reply', role: 'assistant' },
        { content: 'عکس یک سگ', role: 'user' },
      ]),
    ).toBe('عکس یک سگ');
  });

  it('returns empty once an image-gen tool result follows the latest user turn', () => {
    expect(
      findPendingUserMessageText([
        { content: 'عکس یک سگ', role: 'user' },
        { content: '', role: 'assistant' },
        imageGenToolResult,
      ]),
    ).toBe('');
  });

  it('still returns the ask when only an unrelated tool follows the user', () => {
    expect(
      findPendingUserMessageText([
        { content: 'عکس یک سگ', role: 'user' },
        {
          content: 'ok',
          plugin: { apiName: 'readLocalFile', identifier: 'lobe-local-system' },
          role: 'tool',
        },
      ]),
    ).toBe('عکس یک سگ');
  });

  it('strips SYSTEM CONTEXT from the pending prompt', () => {
    expect(
      findPendingUserMessageText([
        { content: `Generate an image of a cat\n\n${pollutedSystemContext}`, role: 'user' },
      ]),
    ).toBe('Generate an image of a cat');
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
