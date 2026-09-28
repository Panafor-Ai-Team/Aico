import { describe, expect, it } from 'vitest';

import {
  findPendingUserMessage,
  isVideoGenerationUserIntent,
  resolveDirectVideoGenerationToolCall,
} from './videoGenerationIntent';

describe('isVideoGenerationUserIntent', () => {
  it('detects Persian video requests', () => {
    expect(isVideoGenerationUserIntent('ویدیو مبارزه ی بین این دوتفر رو بساز')).toBe(true);
    expect(isVideoGenerationUserIntent('یه کلیپ از یه گربه که میرقصه درست کن')).toBe(true);
    expect(isVideoGenerationUserIntent('یک ویدئو کوتاه از غروب دریا تولید کن')).toBe(true);
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
