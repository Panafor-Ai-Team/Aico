import { metrics, trace } from '@opentelemetry/api';

const meter = metrics.getMeter('server-services-agent-runtime');

/**
 * Tracer for Agent Runtime semantic spans (invoke_agent / chat / execute_tool /
 * context_engineering). Shared across `AgentRuntimeService`, `RuntimeExecutors`,
 * and the server-side `serverMessagesEngine`.
 *
 * When OTEL is not initialized, `getTracer` returns a no-op provider, so calling
 * `tracer.startActiveSpan` is safe and cheap in environments without telemetry.
 */
export const tracer = trace.getTracer('@lobechat/agent-runtime', '0.0.1');

/**
 * Count of async sub-agent parent resume attempts grouped by `outcome`:
 * - `resumed`         — won the resume CAS and scheduled the parent's next step
 * - `barrier_held`    — pending tools not all fulfilled yet, re-check armed
 * - `no_pending`      — parked op had no pending tools (snapshot lag), fallback armed
 * - `no_state`        — parent state missing/expired in Redis, cannot resume
 * - `lost_cas`        — another completion won the resume CAS first
 * - `verify_exhausted`— bounded watchdog retries exhausted while still not resumable
 *
 * Lets orphaned `waiting_for_async_tool` parents be detected via the
 * `barrier_held` / `no_pending` / `verify_exhausted` series instead of
 * accumulating silently. For details see: async sub-agent suspend/resume stability hardening — bounded watchdog retry with exponential backoff.
 */
export const asyncToolResumeCounter = meter.createCounter('agent_runtime_async_tool_resume_total', {
  description: 'Count of async sub-agent parent resume attempts grouped by outcome.',
  unit: '{resume}',
});

/**
 * Chat TTFT phase durations (ms), labeled by `phase`.
 *
 * Phases:
 * - `client_pre_http` — client work before the chat HTTP request (e.g. billing allow-gate)
 * - `before_chat_hold` — managed ledger pricing + placeHold before upstream
 * - `context_build` — server context engineering / prompt assembly
 * - `provider_ttft` — chat span start → first stream chunk (includes hold when hold runs inside chat)
 * - `ui_buffer` — SSE text animation buffer delay before first painted token
 */
export const chatTtftPhaseDurationHistogram = meter.createHistogram('chat_ttft_phase_duration_ms', {
  description: 'Observed duration for one phase on the chat time-to-first-token path.',
  unit: 'ms',
});

export type ChatTtftPhase =
  'before_chat_hold' | 'client_pre_http' | 'context_build' | 'provider_ttft' | 'ui_buffer';

export const recordChatTtftPhase = (
  phase: ChatTtftPhase,
  durationMs: number,
  attributes?: Record<string, string | number | boolean>,
): void => {
  if (!Number.isFinite(durationMs) || durationMs < 0) return;
  chatTtftPhaseDurationHistogram.record(durationMs, { phase, ...attributes });
};

export * from './attributes';
export * from './semconv';
