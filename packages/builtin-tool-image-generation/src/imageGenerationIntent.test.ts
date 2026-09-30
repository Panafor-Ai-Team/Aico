import { describe, expect, it } from 'vitest';

import {
  findLatestGeneratedImageUrls,
  findLatestUserMessageText,
  findPendingUserMessageText,
  IMAGE_GENERATION_TOOL_FUNCTION_NAME,
  isImageEditContinuationIntent,
  isImageGenerationUserIntent,
  resolveDirectImageGenerationToolCall,
  resolveForcedImageGenerationToolChoice,
} from './imageGenerationIntent';

const PREVIOUS_IMAGE_URL = 'https://cdn.example.com/previous.png';

const imageGenToolResult = {
  content: [
    'Image generation completed with gpt-image-2.',
    `![Generated image 1](${PREVIOUS_IMAGE_URL})`,
    'Reusable reference URLs for follow-up edits (pass as imageUrl or imageUrls):',
    PREVIOUS_IMAGE_URL,
  ].join('\n'),
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

  it('detects edit / continuation asks that refer to a previous image', () => {
    expect(isImageGenerationUserIntent('add a bird to the previous image')).toBe(true);
    expect(isImageGenerationUserIntent('edit the last picture to make the sky blue')).toBe(true);
    expect(isImageGenerationUserIntent('به عکس قبلی یه پرنده اضافه کن')).toBe(true);
    expect(isImageEditContinuationIntent('add a bird to the previous image')).toBe(true);
    expect(isImageEditContinuationIntent('Generate an image of a dog')).toBe(false);
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

  it('reuses the previous generateImage URL when the user asks to edit that image', () => {
    const call = resolveDirectImageGenerationToolCall({
      messages: [
        { content: 'Generate an image of a cat', role: 'user' },
        { content: '', role: 'assistant' },
        imageGenToolResult,
        { content: 'Here is your cat.', role: 'assistant' },
        { content: 'add a bird to the previous image', role: 'user' },
      ],
    });

    expect(call).toMatchObject({
      apiName: 'generateImage',
      identifier: 'lobe-image-generation',
    });
    expect(JSON.parse(call!.arguments)).toEqual({
      imageUrls: [PREVIOUS_IMAGE_URL],
      prompt: 'add a bird to the previous image',
    });
  });

  it('prefers images attached on the current turn over a previous generation', () => {
    const attached = 'https://cdn.example.com/upload.png';
    const call = resolveDirectImageGenerationToolCall({
      messages: [
        { content: 'Generate an image of a cat', role: 'user' },
        { content: '', role: 'assistant' },
        imageGenToolResult,
        { content: 'Here is your cat.', role: 'assistant' },
        {
          content: [
            { text: 'edit this picture to add a hat', type: 'text' },
            { image_url: { url: attached }, type: 'image_url' },
          ],
          role: 'user',
        },
      ],
    });

    expect(JSON.parse(call!.arguments)).toEqual({
      imageUrls: [attached],
      prompt: 'edit this picture to add a hat',
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

describe('findLatestGeneratedImageUrls', () => {
  it('reads markdown and reusable URL lines from the latest generateImage tool result', () => {
    expect(
      findLatestGeneratedImageUrls([
        { content: 'Generate an image of a cat', role: 'user' },
        { content: '', role: 'assistant' },
        imageGenToolResult,
        { content: 'Here is your cat.', role: 'assistant' },
      ]),
    ).toEqual([PREVIOUS_IMAGE_URL]);
  });

  it('prefers pluginState asset URLs when present', () => {
    const stateUrl = 'https://cdn.example.com/from-state.png';
    expect(
      findLatestGeneratedImageUrls([
        {
          content: 'done',
          name: IMAGE_GENERATION_TOOL_FUNCTION_NAME,
          pluginState: {
            generations: [{ asset: { url: stateUrl } }],
          },
          role: 'tool',
        },
      ]),
    ).toEqual([stateUrl]);
  });
});
