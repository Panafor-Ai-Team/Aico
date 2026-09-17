import { describe, expect, it, vi } from 'vitest';

import { mergeModelRuntimeHooks } from './mergeHooks';
import type { ModelRuntimeHooks } from './ModelRuntime';

describe('mergeModelRuntimeHooks', () => {
  it('returns undefined when both hooks are empty', () => {
    expect(mergeModelRuntimeHooks(undefined, undefined)).toBeUndefined();
  });

  it('returns the only present hook untouched', () => {
    const fn = vi.fn();
    const merged = mergeModelRuntimeHooks({ beforeChat: fn }, undefined);
    expect(merged?.beforeChat).toBe(fn);
  });

  it('chains hooks of the same name in a → b order', async () => {
    const order: string[] = [];
    const a: ModelRuntimeHooks = {
      onGenerateObjectComplete: vi.fn(async () => {
        order.push('a');
      }),
    };
    const b: ModelRuntimeHooks = {
      onGenerateObjectComplete: vi.fn(async () => {
        order.push('b');
      }),
    };

    const merged = mergeModelRuntimeHooks(a, b);
    await merged?.onGenerateObjectComplete?.(
      { latencyMs: 0, success: true },
      {} as Parameters<NonNullable<ModelRuntimeHooks['onGenerateObjectComplete']>>[1],
    );
    expect(order).toEqual(['a', 'b']);
    expect(a.onGenerateObjectComplete).toHaveBeenCalledTimes(1);
    expect(b.onGenerateObjectComplete).toHaveBeenCalledTimes(1);
  });

  it('does not run b when a throws (a is load-bearing)', async () => {
    const bSpy = vi.fn();
    const merged = mergeModelRuntimeHooks(
      {
        onGenerateObjectComplete: async () => {
          throw new Error('billing failed');
        },
      },
      { onGenerateObjectComplete: bSpy },
    );

    await expect(
      merged?.onGenerateObjectComplete?.(
        { latencyMs: 0, success: true },
        {} as Parameters<NonNullable<ModelRuntimeHooks['onGenerateObjectComplete']>>[1],
      ),
    ).rejects.toThrow('billing failed');
    expect(bSpy).not.toHaveBeenCalled();
  });

  it('keeps hooks that exist in only one side without wrapping', () => {
    const onlyInA = vi.fn();
    const onlyInB = vi.fn();
    const merged = mergeModelRuntimeHooks({ beforeChat: onlyInA }, { onChatFinal: onlyInB });
    expect(merged?.beforeChat).toBe(onlyInA);
    expect(merged?.onChatFinal).toBe(onlyInB);
  });

  it('chains the metering hooks (tts, transcribe, embeddings complete)', async () => {
    const order: string[] = [];
    const push = (tag: string) => vi.fn(async () => void order.push(tag));
    const merged = mergeModelRuntimeHooks(
      {
        beforeTextToSpeech: push('a-tts'),
        beforeTranscribe: push('a-asr'),
        onEmbeddingsComplete: push('a-emb'),
      },
      {
        beforeTextToSpeech: push('b-tts'),
        beforeTranscribe: push('b-asr'),
        onEmbeddingsComplete: push('b-emb'),
      },
    );

    await merged?.beforeTextToSpeech?.({ input: '', model: 'm', voice: 'v' });
    await merged?.beforeTranscribe?.({ model: 'm' } as any);
    await merged?.onEmbeddingsComplete?.(
      { latencyMs: 0, success: true },
      { payload: { input: '', model: 'm' } },
    );
    expect(order).toEqual(['a-tts', 'b-tts', 'a-asr', 'b-asr', 'a-emb', 'b-emb']);
  });
});
