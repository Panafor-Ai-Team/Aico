import { IMAGE_GENERATION_TOOL_FUNCTION_NAME } from '@lobechat/builtin-tool-image-generation';
import { describe, expect, it, vi } from 'vitest';

import { ServerContextBuilder } from './ServerContextBuilder';

vi.mock('./serverCallLlmTooling', () => ({
  resolveServerCallLlmTooling: () => ({
    resolved: {
      executorMap: {},
      sourceMap: {},
      tools: [{ function: { name: IMAGE_GENERATION_TOOL_FUNCTION_NAME }, type: 'function' }],
    },
  }),
}));

const processedMessagesMock = vi.hoisted(() => ({ messages: [] as any[] }));

vi.mock('./serverCallLlmContextBuilder', () => ({
  buildServerCallLlmContext: vi.fn(async () => ({
    modelDisplayName: undefined,
    modelKnowledgeCutoff: undefined,
    preserveThinkingForPayload: undefined,
    processedMessages: processedMessagesMock.messages,
    replayAssistantReasoning: undefined,
    resolvedExtendParams: undefined,
    shouldReplayAssistantReasoning: undefined,
  })),
}));

const attached = 'https://cdn.example.com/balloon.png';

const buildFor = (text: string) => {
  processedMessagesMock.messages = [{ content: text, role: 'user' }];
  return new ServerContextBuilder({} as any).build({
    model: 'openrouter/auto',
    payload: { messages: [{ content: text, role: 'user' }] } as any,
    provider: 'cheapvibecode',
    state: {} as any,
  } as any);
};

describe('ServerContextBuilder one-shot media calls on task runs', () => {
  // Bug: a scheduled "daily learning" task whose instruction said "bring me a
  // 15-minute article, video or podcast" was read as a video request. The
  // runtime skipped the model, called generateVideo directly and the run
  // failed (video gateway 402) before the model ever saw the task.
  const taskRunPrompt = [
    '<task>',
    '<hint>This tag contains the complete task context. Do NOT call viewTask to re-fetch it.</hint>',
    'T-1 یادگیری روزانه',
    'Automation: cron "30 7 * * *" (Asia/Tehran)',
    'Instruction: هر روز صبح ساعت ۰۷:۳۰، یک محتوای ۱۵ دقیقه‌ای منتخب (مقاله، ویدیو یا پادکست) در حوزه یادگیری من بیاور، با یک نکته کلیدی.',
    '</task>',
  ].join('\n');

  it('leaves a task run to the model instead of calling a generator directly', async () => {
    const output = await buildFor(taskRunPrompt);

    expect(output.directToolCalls).toBeUndefined();
    expect(
      (output.modelParameters as Record<string, unknown> | undefined)?.tool_choice,
    ).toBeUndefined();
  });

  it('still calls the video generator directly for a plain chat request', async () => {
    const output = await buildFor('یه ویدیو ۵ ثانیه‌ای از یه گربه بساز');

    expect(output.directToolCalls?.[0]).toMatchObject({ apiName: 'generateVideo' });
  });
});

describe('ServerContextBuilder image tool_choice fallback', () => {
  it('forces the image tool for an attached-image edit even when the direct call sees no pending ask', async () => {
    // Raw/display divergence: the raw transcript already records an answered
    // ask (so the direct call stands down), while the prepared rows still
    // carry the pending attached-image edit. The tool_choice fallback must
    // still see the attachment — otherwise the turn runs text-only and the
    // model reports the image tool as unavailable.
    processedMessagesMock.messages = [
      {
        content: [
          { text: 'رنگشو زرد کن', type: 'text' },
          { image_url: { url: attached }, type: 'image_url' },
        ],
        role: 'user',
      },
    ];
    const rawMessages = [
      { content: 'رنگشو زرد کن', role: 'user' },
      { content: '', role: 'assistant' },
      {
        content: 'done',
        name: IMAGE_GENERATION_TOOL_FUNCTION_NAME,
        role: 'tool',
      },
    ];

    const builder = new ServerContextBuilder({} as any);
    const output = await builder.build({
      model: 'openrouter/auto',
      payload: { messages: rawMessages } as any,
      provider: 'cheapvibecode',
      state: {} as any,
    } as any);

    expect(output.directToolCalls).toBeUndefined();
    expect((output.modelParameters as Record<string, unknown> | undefined)?.tool_choice).toEqual({
      function: { name: IMAGE_GENERATION_TOOL_FUNCTION_NAME },
      type: 'function',
    });
  });

  it('does not force the image tool for a question about an attached image', async () => {
    processedMessagesMock.messages = [
      {
        content: [
          { text: 'what color is this car?', type: 'text' },
          { image_url: { url: attached }, type: 'image_url' },
        ],
        role: 'user',
      },
    ];

    const builder = new ServerContextBuilder({} as any);
    const output = await builder.build({
      model: 'openrouter/auto',
      payload: { messages: [] } as any,
      provider: 'cheapvibecode',
      state: {} as any,
    } as any);

    expect(output.directToolCalls).toBeUndefined();
    expect(
      (output.modelParameters as Record<string, unknown> | undefined)?.tool_choice,
    ).toBeUndefined();
  });
});
