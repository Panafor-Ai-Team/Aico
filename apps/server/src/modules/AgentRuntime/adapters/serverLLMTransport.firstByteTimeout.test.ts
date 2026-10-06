// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

import { classifyLLMError } from '../llmErrorClassification';
import { ServerLLMTransport } from './ServerLLMTransport';

const makeCtx = () =>
  ({
    operationId: 'op-1',
    stepIndex: 0,
    stream: true,
    streamManager: { publishStreamChunk: vi.fn().mockResolvedValue(undefined) },
    userId: 'user-1',
  }) as any;

const makeInput = () =>
  ({
    attempt: 1,
    context: {
      messages: [{ content: 'hello', role: 'user' }],
      resolvedTools: { executorMap: {}, promptManifestMap: {}, sourceMap: {}, tools: [] },
    },
    events: [],
    maxAttempts: 6,
    model: 'test-model',
    provider: 'openrouter',
    state: { metadata: {} },
  }) as any;

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('ServerLLMTransport runAttempt first-byte timeout', () => {
  it('fails a hung upstream fast with a retryable error instead of riding the SDK default', async () => {
    vi.useFakeTimers();
    try {
      const transport = new ServerLLMTransport(makeCtx());
      const chat = vi.fn().mockReturnValue(new Promise(() => {}));
      const pending = (transport as any).runAttemptWithRuntime(makeInput(), { chat });
      // Attach before advancing timers so the timeout rejection is never unhandled.
      void pending.catch(() => {});

      await vi.advanceTimersByTimeAsync(60_000);
      const result = await pending;

      expect(chat).toHaveBeenCalledTimes(1);
      expect(result.ok).toBe(false);
      expect(String(result.error?.message)).toContain('timed out');
      expect(String(result.error?.message)).toContain('[stall-guard]');
      // A hung gateway flap must keep self-healing through the retry policy.
      expect(classifyLLMError(result.error).kind).toBe('retry');
    } finally {
      vi.useRealTimers();
    }
  });

  it('spends a cumulative first-byte budget across attempts instead of 60s each', async () => {
    vi.useFakeTimers();
    try {
      const transport = new ServerLLMTransport(makeCtx());
      const runAttempt = (attempt: number) =>
        (transport as any).runAttemptWithRuntime(
          { ...makeInput(), attempt },
          {
            chat: vi.fn().mockReturnValue(new Promise(() => {})),
          },
        );

      const first = runAttempt(1);
      void first.catch(() => {});
      await vi.advanceTimersByTimeAsync(60_000);
      expect((await first).ok).toBe(false);

      const second = runAttempt(2);
      void second.catch(() => {});
      await vi.advanceTimersByTimeAsync(60_000);
      expect((await second).ok).toBe(false);

      // Budget (120s) spent: the third attempt fails at once, with no
      // timer advance needed, instead of burning another minute.
      const third = await runAttempt(3);
      expect(third.ok).toBe(false);
      expect(String(third.error?.message)).toContain('budget');
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips backoff sleep after our own stall timeouts but keeps it otherwise', async () => {
    vi.useFakeTimers();
    try {
      const transport = new ServerLLMTransport(makeCtx());
      const policy = transport.retryPolicy as unknown as {
        onRetry: (input: {
          attempt: number;
          delayMs: number;
          error: { kind: string; message: string };
          maxAttempts: number;
        }) => void;
        waitForRetry: (delayMs: number) => Promise<void>;
      };

      policy.onRetry({
        attempt: 1,
        delayMs: 30_000,
        error: { kind: 'retry', message: 'LLM attempt timed out: nope [stall-guard]' },
        maxAttempts: 6,
      });
      await policy.waitForRetry(30_000);

      policy.onRetry({
        attempt: 2,
        delayMs: 30_000,
        error: { kind: 'retry', message: 'Upstream 503' },
        maxAttempts: 6,
      });
      let slept = false;
      const pending = policy.waitForRetry(30_000).then(() => {
        slept = true;
      });
      await vi.advanceTimersByTimeAsync(29_999);
      expect(slept).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(slept).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets a slow completion through while chunks keep flowing', async () => {
    vi.useFakeTimers();
    try {
      const transport = new ServerLLMTransport(makeCtx());
      const chat = vi.fn().mockImplementation(async (_payload: any, options: any) => {
        await options?.callback?.onText?.('hello');
        // 61s total but never silent for 60s: neither the first-byte cap
        // (disarmed at the first chunk) nor the inactivity watchdog may fire.
        await new Promise((resolve) => setTimeout(resolve, 59_000));
        await options?.callback?.onText?.(' world');
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        return new Response('hello world');
      });
      const pending = (transport as any).runAttemptWithRuntime(makeInput(), { chat });

      await vi.advanceTimersByTimeAsync(65_000);
      const result = await pending;

      expect(result.ok).toBe(true);
      expect(result.output.content).toContain('hello');
    } finally {
      vi.useRealTimers();
    }
  });
});
