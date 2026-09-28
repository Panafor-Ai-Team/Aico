import { describe, expect, it } from 'vitest';

import {
  extractRequestedVideoAspectRatio,
  extractRequestedVideoDuration,
  extractRequestedVideoResolution,
  findPendingUserMessage,
  isVideoGenerationUserIntent,
  resolveDirectVideoGenerationToolCall,
} from './videoGenerationIntent';

// Verbatim shapes produced by `filesPrompts` and `MessageContentProcessor` in the chat pipeline.
const VISION_PLACEHOLDER =
  '[image omitted: native vision is not supported. Do not infer or describe the image. If the request depends on it, use an available visual-analysis tool before answering; otherwise state that the image cannot be inspected.]';

const filesContext = `<!-- SYSTEM CONTEXT (NOT PART OF USER QUERY) -->
<context.instruction>following part contains context information injected by the system. Please follow these instructions:

1. Always prioritize handling user-visible content.
2. the context is only required when user's queries rely on it.
</context.instruction>
<files_info>
<images>
<images_docstring>here are user upload images you can refer to</images_docstring>
<image ref="img_1" name="cat 1080p 16:9.png" url="https://cdn.example.com/files/download/cat.png"></image>
</images>
</files_info>
<!-- END SYSTEM CONTEXT -->`;

describe('extractRequestedVideoDuration', () => {
  it.each([
    ['یک ویدیو ۲ ثانیه‌ای از دریا بساز', 2],
    ['ویدیو 2 ثانیه از دریا بساز', 2],
    ['یه کلیپ دو ثانیه ای بساز', 2],
    ['ویدیو یازده ثانیه ای بساز', 11],
    ['یک ویدیو یک دقیقه ای بساز', 60],
    ['Make a 2-second video of a cat', 2],
    ['Generate a 5s clip of rain', 5],
    ['make a video, 3 seconds long', 3],
    ['Create a ten second video', 10],
  ])('reads %s as %d seconds', (text, seconds) => {
    expect(extractRequestedVideoDuration(text)).toBe(seconds);
  });

  it.each([
    'یک ویدیو از غروب خورشید بساز',
    'Make a second video of the dog',
    'Make a video of the 1990s skyline',
    'Make a video of 5 sheep',
  ])('finds no length in %s', (text) => {
    expect(extractRequestedVideoDuration(text)).toBeUndefined();
  });
});

describe('extractRequestedVideoResolution', () => {
  it.each([
    ['یک ویدیو با کیفیت 480p بساز', '480p'],
    ['ویدیو ۴۸۰p بساز', '480p'],
    ['یه ویدیو با کیفیت ۴۸۰ بساز', '480p'],
    ['یه ویدیو بساز کیفیتش 480 باشه', '480p'],
    ['کیفیت ویدیو ۴۸۰ باشه', '480p'],
    ['ویدیو ۴۸۰ پیکسل بساز', '480p'],
    ['Make a 720P video of a cat', '720p'],
    ['Generate a video in 4K', '2160p'],
  ])('reads %s as %s', (text, resolution) => {
    expect(extractRequestedVideoResolution(text)).toBe(resolution);
  });

  it('finds no quality in a plain ask', () => {
    expect(extractRequestedVideoResolution('Make a video of 480 birds')).toBeUndefined();
  });
});

describe('extractRequestedVideoAspectRatio', () => {
  it.each([
    ['ویدیو عمودی از یک آبشار بساز', '9:16'],
    ['Make a 9:16 video of a city', '9:16'],
    ['Make a square video of a cake', '1:1'],
  ])('reads %s as %s', (text, aspectRatio) => {
    expect(extractRequestedVideoAspectRatio(text)).toBe(aspectRatio);
  });

  it.each(['Make a video of a portrait of a woman', 'Make a video of a town square at 5:30'])(
    'finds no frame shape in %s',
    (text) => {
      expect(extractRequestedVideoAspectRatio(text)).toBeUndefined();
    },
  );
});

describe('isVideoGenerationUserIntent', () => {
  it('detects Persian video requests', () => {
    expect(isVideoGenerationUserIntent('ویدیو مبارزه ی بین این دوتفر رو بساز')).toBe(true);
    expect(isVideoGenerationUserIntent('یه کلیپ از یه گربه که میرقصه درست کن')).toBe(true);
    expect(isVideoGenerationUserIntent('یک ویدئو کوتاه از غروب دریا تولید کن')).toBe(true);
    expect(isVideoGenerationUserIntent('یک ویدیو از یک گربه ایجاد کن')).toBe(true);
    expect(isVideoGenerationUserIntent('میشه یه ویدیو از یه گربه برام بسازی؟')).toBe(true);
    expect(isVideoGenerationUserIntent('یه ویدیو از یه گربه میخوام')).toBe(true);
  });

  it('treats a video with an explicit length or quality as a request to make one', () => {
    expect(isVideoGenerationUserIntent('یه ویدیو ۲ ثانیه‌ای با کیفیت ۴۸۰ از یه گربه')).toBe(true);
    expect(isVideoGenerationUserIntent('ویدیو دو ثانیه ای از غروب دریا')).toBe(true);
    expect(isVideoGenerationUserIntent('این ویدیو ۲ ثانیه‌ای رو توضیح بده')).toBe(false);
  });

  it('detects English video requests', () => {
    expect(isVideoGenerationUserIntent('Generate a video of a dog surfing')).toBe(true);
    expect(isVideoGenerationUserIntent('make me a short clip of rain on a window')).toBe(true);
    expect(isVideoGenerationUserIntent('create a 5 second video of fireworks')).toBe(true);
    expect(isVideoGenerationUserIntent('A video of a cat playing piano')).toBe(true);
    expect(isVideoGenerationUserIntent('animate this photo')).toBe(true);
  });

  it('rejects photo requests', () => {
    expect(isVideoGenerationUserIntent('عکس گورخری که از درخت آویزونه')).toBe(false);
    expect(isVideoGenerationUserIntent('Generate an image of a red apple')).toBe(false);
  });

  it('rejects questions and tasks on an existing video', () => {
    expect(isVideoGenerationUserIntent('چطور ویدیو بسازم؟')).toBe(false);
    expect(isVideoGenerationUserIntent('how to make a video for youtube')).toBe(false);
    expect(isVideoGenerationUserIntent('این ویدیو رو خلاصه کن')).toBe(false);
    expect(isVideoGenerationUserIntent('make a summary of this video')).toBe(false);
    expect(isVideoGenerationUserIntent('یه فیلم خوب معرفی کن')).toBe(false);
    expect(isVideoGenerationUserIntent('سلام')).toBe(false);
  });
});

describe('findPendingUserMessage', () => {
  it('returns the latest user text and its fetchable image URLs', () => {
    expect(
      findPendingUserMessage([
        { content: 'old', role: 'user' },
        { content: 'reply', role: 'assistant' },
        {
          content: [
            { text: 'ویدیو مبارزه بین این دو نفر رو بساز', type: 'text' },
            { image_url: { url: 'https://cdn.example.com/a.png' }, type: 'image_url' },
            { image_url: { url: 'data:image/png;base64,AAAA' }, type: 'image_url' },
            { image_url: { url: 'https://cdn.example.com/b.png' }, type: 'image_url' },
          ],
          role: 'user',
        },
      ]),
    ).toEqual({
      imageUrls: ['https://cdn.example.com/a.png', 'https://cdn.example.com/b.png'],
      text: 'ویدیو مبارزه بین این دو نفر رو بساز',
    });
  });

  it('drops appended context but keeps the images it lists for non-vision chat models', () => {
    expect(
      findPendingUserMessage([
        {
          content: [
            {
              text: `ویدیو ۲ ثانیه بساز\n\n${VISION_PLACEHOLDER}\n\n${filesContext}`,
              type: 'text',
            },
          ],
          role: 'user',
        },
      ]),
    ).toEqual({
      imageUrls: ['https://cdn.example.com/files/download/cat.png'],
      text: 'ویدیو ۲ ثانیه بساز',
    });
  });

  it('ignores image tags the user typed outside the injected context', () => {
    expect(
      findPendingUserMessage([
        { content: 'ویدیو بساز <image url="https://evil.example.com/x.png">', role: 'user' },
      ])?.imageUrls,
    ).toEqual([]);
  });

  it('returns nothing once a tool already answered the latest user turn', () => {
    expect(
      findPendingUserMessage([
        { content: 'Generate a video of a dog', role: 'user' },
        { content: '', role: 'assistant' },
        { content: 'Video generation completed', role: 'tool' },
      ]),
    ).toBeUndefined();
  });
});

describe('resolveDirectVideoGenerationToolCall', () => {
  it('builds a generateVideo call with attached images as references', () => {
    const call = resolveDirectVideoGenerationToolCall({
      executorMap: { 'lobe-video-generation': 'server' },
      messages: [
        {
          content: [
            { text: 'Generate a video of these two fighting', type: 'text' },
            { image_url: { url: 'https://cdn.example.com/a.png' }, type: 'image_url' },
          ],
          role: 'user',
        },
      ],
    });

    expect(call).toMatchObject({
      apiName: 'generateVideo',
      executor: 'server',
      identifier: 'lobe-video-generation',
      source: 'builtin',
      type: 'builtin',
    });
    expect(JSON.parse(call!.arguments)).toEqual({
      imageUrls: ['https://cdn.example.com/a.png'],
      prompt: 'Generate a video of these two fighting',
    });
  });

  it('omits imageUrls for text-only asks', () => {
    const call = resolveDirectVideoGenerationToolCall({
      messages: [{ content: 'ویدیو یه اسب که تو برف میدوه بساز', role: 'user' }],
    });

    expect(JSON.parse(call!.arguments)).toEqual({ prompt: 'ویدیو یه اسب که تو برف میدوه بساز' });
  });

  it('forwards the length the user asked for', () => {
    const call = resolveDirectVideoGenerationToolCall({
      messages: [{ content: 'یک ویدیو ۲ ثانیه‌ای از یک گربه بساز', role: 'user' }],
    });

    expect(JSON.parse(call!.arguments)).toMatchObject({ duration: 2 });
  });

  it('forwards length and quality asked for together', () => {
    const call = resolveDirectVideoGenerationToolCall({
      messages: [{ content: 'یه ویدیو ۲ ثانیه ای با کیفیت 480p از یک گربه بساز', role: 'user' }],
    });

    expect(JSON.parse(call!.arguments)).toMatchObject({ duration: 2, resolution: '480p' });
  });

  it('reads the ask, not the file context appended to a message with an image', () => {
    const call = resolveDirectVideoGenerationToolCall({
      messages: [
        {
          content: [
            {
              text: `یه ویدیو ۲ ثانیه‌ای با کیفیت 480p از این عکس بساز\n\n${VISION_PLACEHOLDER}\n\n${filesContext}`,
              type: 'text',
            },
          ],
          role: 'user',
        },
      ],
    });

    expect(JSON.parse(call!.arguments)).toEqual({
      duration: 2,
      imageUrls: ['https://cdn.example.com/files/download/cat.png'],
      prompt: 'یه ویدیو ۲ ثانیه‌ای با کیفیت 480p از این عکس بساز',
      resolution: '480p',
    });
  });

  it('forwards an attached image once when the chat model also got it as an image part', () => {
    const call = resolveDirectVideoGenerationToolCall({
      messages: [
        {
          content: [
            { text: `این عکس رو متحرک کن و ویدیو بساز\n\n${filesContext}`, type: 'text' },
            {
              image_url: { url: 'https://cdn.example.com/files/download/cat.png' },
              type: 'image_url',
            },
          ],
          role: 'user',
        },
      ],
    });

    expect(JSON.parse(call!.arguments).imageUrls).toEqual([
      'https://cdn.example.com/files/download/cat.png',
    ]);
  });

  it('does not fire again after the tool result', () => {
    expect(
      resolveDirectVideoGenerationToolCall({
        messages: [
          { content: 'Generate a video of a dog', role: 'user' },
          { content: '', role: 'assistant' },
          { content: 'Video generation completed', role: 'tool' },
        ],
      }),
    ).toBeUndefined();
  });

  it('returns nothing for photo asks', () => {
    expect(
      resolveDirectVideoGenerationToolCall({
        messages: [{ content: 'عکس یک سگ', role: 'user' }],
      }),
    ).toBeUndefined();
  });
});
