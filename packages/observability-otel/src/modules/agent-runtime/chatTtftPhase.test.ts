import { describe, expect, it, vi } from 'vitest';

const record = vi.fn();

vi.mock('@opentelemetry/api', () => ({
  metrics: {
    getMeter: () => ({
      createCounter: () => ({ add: vi.fn() }),
      createHistogram: () => ({ record }),
    }),
  },
  trace: {
    getTracer: () => ({ startSpan: vi.fn() }),
  },
}));

describe('recordChatTtftPhase', () => {
  it('records finite non-negative durations with the phase label', async () => {
    record.mockClear();
    const { recordChatTtftPhase } = await import('./index');

    recordChatTtftPhase('client_pre_http', 42, { provider: 'aico' });
    expect(record).toHaveBeenCalledWith(42, { phase: 'client_pre_http', provider: 'aico' });
  });

  it('ignores invalid durations', async () => {
    record.mockClear();
    const { recordChatTtftPhase } = await import('./index');

    recordChatTtftPhase('ui_buffer', Number.NaN);
    recordChatTtftPhase('ui_buffer', -1);
    expect(record).not.toHaveBeenCalled();
  });
});
