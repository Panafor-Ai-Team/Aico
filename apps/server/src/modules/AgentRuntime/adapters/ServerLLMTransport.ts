import type {
  BlobStore,
  LLMAttemptExecution,
  LLMAttemptInput,
  LLMAttemptOutput,
  LLMCallErrorInput,
  LLMRetryInput,
  LLMRetryPolicy,
  LLMStreamPayload,
  LLMStreamResult,
  LLMTrace,
  LLMTraceInput,
  LLMTransport,
} from '@lobechat/agent-runtime';
import { resolveLLMMaxAttempts, resolveLLMRetryBudget } from '@lobechat/agent-runtime';
import { BRANDING_PROVIDER } from '@lobechat/business-const';
import {
  type ChatStreamPayload,
  consumeStreamUntilDone,
  type ModelRuntime,
} from '@lobechat/model-runtime';
import {
  context as otelContext,
  SpanKind,
  SpanStatusCode,
  trace as otelTrace,
} from '@lobechat/observability-otel/api';
import {
  buildChatRequestAttributes,
  buildChatResponseAttributes,
  chatSpanName,
  recordChatTtftPhase,
  tracer as agentRuntimeTracer,
} from '@lobechat/observability-otel/modules/agent-runtime';

import { initModelRuntimeFromDB } from '@/server/modules/ModelRuntime';

import type { RuntimeExecutorContext } from '../context';
import { log, sleep } from '../executorHelpers';
import { classifyLLMError } from '../llmErrorClassification';
import { createServerCallLlmAttempt } from './serverCallLlmAttempt';

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message) return message;
  }
  return JSON.stringify(error);
};

const SERVER_LLM_RETRY_POLICY = {
  noRetryProviders: [BRANDING_PROVIDER],
};

// Bound for time-to-first-chunk of one LLM attempt. Attempts that produce no
// chunk at all (tool-call-only turns, fast failures) settle on their own; a
// hung upstream that sends nothing fails here instead of riding the OpenAI
// SDK default (10 min) and multiplying across the 6-attempt retry policy.
// The message carries "timed out" so the retry classifier keeps it retryable.
const LLM_FIRST_BYTE_TIMEOUT_MS = 60_000;

// Cumulative first-byte budget for one call_llm step across its attempts.
// Per-attempt caps alone still sum to minutes during a full outage; once the
// budget is spent, remaining attempts fail immediately so the run ends fast.
// Healthy and flapping upstreams finish inside the budget and never notice it.
const LLM_FIRST_BYTE_BUDGET_MS = 120_000;

// Marks our own stall-guard timeouts. Neutral to the error classifier (keeps
// them retryable via "timed out") but lets the retry policy skip backoff
// sleeps: spacing retries helps rate limits, which fail fast — not hangs.
const STALL_GUARD_MARKER = '[stall-guard]';

class ServerLLMRetryPolicy implements LLMRetryPolicy {
  private lastFailureWasStall = false;

  constructor(private readonly ctx: RuntimeExecutorContext) {}

  classifyError(error: unknown) {
    return classifyLLMError(error);
  }

  maxAttempts(provider: string) {
    return resolveLLMMaxAttempts(provider, SERVER_LLM_RETRY_POLICY);
  }

  onError({ error }: LLMCallErrorInput) {
    console.error(
      `[StreamingLLMExecutor][${this.ctx.operationId}:${this.ctx.stepIndex}] LLM execution failed:`,
      error,
    );
  }

  onRetry({ attempt, delayMs, error, maxAttempts }: LLMRetryInput) {
    log(
      '[%s:%d] LLM call failed with kind=%s (attempt %d/%d), retrying in %dms ...',
      this.ctx.operationId,
      this.ctx.stepIndex,
      error.kind,
      attempt,
      maxAttempts,
      delayMs,
    );
    this.lastFailureWasStall = error.message?.includes(STALL_GUARD_MARKER) ?? false;
  }

  resolveRetryBudget(provider: string) {
    return resolveLLMRetryBudget(provider, SERVER_LLM_RETRY_POLICY);
  }

  async waitForRetry(delayMs: number): Promise<void> {
    // A hung gateway will not recover during backoff; retry at once instead
    // of adding up to a minute of dead sleep across attempts.
    if (this.lastFailureWasStall) {
      this.lastFailureWasStall = false;
      return;
    }
    await sleep(delayMs);
  }
}

class ServerLLMTrace implements LLMTrace {
  private readonly chatContext: ReturnType<typeof otelTrace.setSpan>;
  private readonly chatSpan: ReturnType<typeof agentRuntimeTracer.startSpan>;
  private firstChunkAt?: number;
  private readonly llmStartTime = Date.now();
  private readonly operationLogId: string;

  constructor(
    private readonly ctx: RuntimeExecutorContext,
    input: LLMTraceInput,
  ) {
    this.operationLogId = `${ctx.operationId}:${ctx.stepIndex}`;
    log(
      '[%s][call_llm] Starting operation with prepared assistant message: %s',
      this.operationLogId,
      input.assistantMessageId,
    );

    this.chatSpan = agentRuntimeTracer.startSpan(chatSpanName(input.model), {
      attributes: buildChatRequestAttributes({
        conversationId: input.conversationId,
        operationId: ctx.operationId,
        provider: input.provider,
        requestModel: input.model,
        stepIndex: ctx.stepIndex,
        stream: ctx.stream ?? true,
      }),
      kind: SpanKind.CLIENT,
    });
    this.chatContext = otelTrace.setSpan(otelContext.active(), this.chatSpan);
  }

  close(error?: unknown) {
    if (error) {
      this.chatSpan.recordException(error as Error);
      this.chatSpan.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    this.chatSpan.end();
  }

  onFirstChunk() {
    if (this.firstChunkAt === undefined) {
      this.firstChunkAt = Date.now() - this.llmStartTime;
      recordChatTtftPhase('provider_ttft', this.firstChunkAt);
    }
  }

  recordResult(output: LLMAttemptOutput) {
    return this.run(async () => {
      log('[%s] call_llm completed', this.operationLogId);
      this.chatSpan.setAttributes(
        buildChatResponseAttributes({
          cacheReadInputTokens: output.usage?.inputCachedTokens,
          finishReasons: output.finishReason ? [output.finishReason] : undefined,
          inputTokens: output.usage?.totalInputTokens,
          outputTokens: output.usage?.totalOutputTokens,
          reasoningOutputTokens: output.usage?.outputReasoningTokens,
          timeToFirstChunkMs: this.firstChunkAt,
        }),
      );
    });
  }

  run<T>(task: () => Promise<T>): Promise<T> {
    return otelContext.with(this.chatContext, task);
  }
}

/**
 * Server {@link LLMTransport} adapter — wraps model-runtime streaming and
 * returns the aggregated content/usage that package executors need.
 */
export class ServerLLMTransport implements LLMTransport {
  readonly retryPolicy: LLMRetryPolicy;

  private readonly modelRuntimePromises = new Map<
    string,
    ReturnType<ServerLLMTransport['createModelRuntime']>
  >();

  // Cumulative first-byte budget tracking for the current call_llm step.
  // Attempt numbers restart at 1 on every step, which is the reset signal.
  private firstByteBudgetKey?: string;
  private firstByteBudgetStartedAt = 0;
  private lastAttemptNumber = 0;

  constructor(
    private readonly ctx: RuntimeExecutorContext,
    private readonly blobStore?: BlobStore,
  ) {
    this.retryPolicy = new ServerLLMRetryPolicy(ctx);
  }

  createTrace(input: LLMTraceInput): LLMTrace {
    return new ServerLLMTrace(this.ctx, input);
  }

  async runAttempt(input: LLMAttemptInput): Promise<LLMAttemptExecution> {
    const modelRuntime = await this.getModelRuntime(input.provider);
    return this.runAttemptWithRuntime(input, modelRuntime);
  }

  async stream(
    payload: LLMStreamPayload,
    handlers?: Parameters<LLMTransport['stream']>[1],
  ): Promise<LLMStreamResult> {
    const runtime = await this.createModelRuntime(payload.provider);
    const { provider: _provider, ...runtimePayload } = payload;
    let content = '';
    let usage: LLMStreamResult['usage'];
    let streamError: unknown;

    const response = await runtime.chat(runtimePayload as any, {
      callback: {
        onCompletion: async (data: any) => {
          if (data.usage) usage = data.usage;
        },
        onError: async (errorData: unknown) => {
          streamError = errorData;
          handlers?.onError?.(errorData);
        },
        onText: async (text: string) => {
          content += text;
          handlers?.onText?.(text);
        },
      },
      user: this.ctx.userId,
    });

    await consumeStreamUntilDone(response);

    if (streamError) {
      throw new Error(getErrorMessage(streamError));
    }

    const result = { content, usage };
    handlers?.onFinish?.(result);
    return result;
  }

  private createModelRuntime(provider: string) {
    return initModelRuntimeFromDB(
      this.ctx.serverDB,
      this.ctx.userId!,
      provider,
      this.ctx.workspaceId,
    );
  }

  private getModelRuntime(provider: string) {
    let promise = this.modelRuntimePromises.get(provider);
    if (!promise) {
      promise = this.createModelRuntime(provider);
      this.modelRuntimePromises.set(provider, promise);
    }
    return promise;
  }

  private async runAttemptWithRuntime(
    input: LLMAttemptInput,
    modelRuntime: Pick<ModelRuntime, 'chat'>,
  ): Promise<LLMAttemptExecution> {
    const resolved = input.context.resolvedTools;
    if (!resolved) throw new Error('Resolved tools are required for a server LLM attempt');

    const tools = resolved.tools.length > 0 ? resolved.tools : undefined;
    const chatPayload = {
      messages: input.context.messages as ChatStreamPayload['messages'],
      model: input.model,
      stream: this.ctx.stream ?? true,
      tools,
      ...(input.context.modelParameters as Partial<ChatStreamPayload>),
      ...(typeof input.context.preserveThinking === 'boolean' && {
        preserveThinking: input.context.preserveThinking,
      }),
    };
    const operationLogId = `${this.ctx.operationId}:${this.ctx.stepIndex}`;
    // New step (attempts restart at 1) or new operation: restart the budget.
    if (this.firstByteBudgetKey !== operationLogId || input.attempt <= this.lastAttemptNumber) {
      this.firstByteBudgetKey = operationLogId;
      this.firstByteBudgetStartedAt = Date.now();
    }
    this.lastAttemptNumber = input.attempt;
    const firstByteCapMs = Math.max(
      0,
      Math.min(
        LLM_FIRST_BYTE_TIMEOUT_MS,
        LLM_FIRST_BYTE_BUDGET_MS - (Date.now() - this.firstByteBudgetStartedAt),
      ),
    );
    let notifyFirstChunk!: () => void;
    const firstChunkPromise = new Promise<void>((resolve) => {
      notifyFirstChunk = resolve;
    });
    let firstByteTimer: ReturnType<typeof setTimeout> | undefined;
    const firstByteTimeout = new Promise<never>((_, reject) => {
      if (firstByteCapMs <= 0) {
        // Budget spent by earlier attempts: fail at once so the remaining
        // attempts exhaust immediately instead of burning another minute each.
        reject(
          new Error(
            `LLM attempt timed out: first-byte budget of ${LLM_FIRST_BYTE_BUDGET_MS}ms spent (model ${input.model}) ${STALL_GUARD_MARKER}`,
          ),
        );
        return;
      }
      firstByteTimer = setTimeout(() => {
        reject(
          new Error(
            `LLM attempt timed out: no chunk within ${firstByteCapMs}ms (model ${input.model}) ${STALL_GUARD_MARKER}`,
          ),
        );
      }, firstByteCapMs);
    });
    const attempt = createServerCallLlmAttempt({
      attempt: input.attempt,
      blobStore: this.blobStore,
      chatPayload,
      ctx: this.ctx,
      events: input.events,
      maxAttempts: input.maxAttempts,
      messageCount: chatPayload.messages.length,
      model: input.model,
      modelRuntime,
      onFirstChunk: () => {
        notifyFirstChunk();
        input.onFirstChunk?.();
      },
      operationLogId,
      provider: input.provider,
      resolved,
      // Carry the originating request's client IP / user agent from the run's
      // state.metadata into the attempt so the LLM-call metadata can surface them
      // for auditing and spend attribution.
      clientIp: input.state.metadata?.clientIp,
      topicId: input.state.metadata?.topicId,
      trigger: input.state.metadata?.trigger,
      userAgent: input.state.metadata?.userAgent,
    });

    // A hung upstream loses at the first-byte cap; an attempt that settles on
    // its own (fast failure, tool-call-only turn with no text chunks) resolves
    // through `executing`; once the first chunk lands the cap is disarmed and
    // the remainder streams unbounded so long generations are never cut.
    const executing = attempt.execute();
    try {
      const firstByteOrSettled = await Promise.race([
        firstByteTimeout,
        executing.then(
          () => 'settled' as const,
          (error: unknown) => {
            throw error;
          },
        ),
        firstChunkPromise.then(() => 'first-byte' as const),
      ]);
      if (firstByteOrSettled === 'first-byte') {
        clearTimeout(firstByteTimer);
        await executing;
      }
      return { ok: true, output: attempt.snapshot() };
    } catch (error) {
      attempt.clearBuffers();
      return { error, ok: false, output: attempt.snapshot() };
    } finally {
      clearTimeout(firstByteTimer);
    }
  }
}
