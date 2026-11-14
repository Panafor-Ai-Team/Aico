import { describe, expect, it } from 'vitest';

import type { Operation, QueuedMessage } from '../slices/operation/types';
import { hasChatWorkInFlight } from './chatWorkInFlight';

const op = (type: Operation['type'], status: Operation['status']) =>
  ({ id: `${type}-${status}`, status, type }) as Operation;

const state = (operations: Operation[], queuedMessages: Record<string, QueuedMessage[]> = {}) => ({
  operations: Object.fromEntries(operations.map((item) => [item.id, item])),
  queuedMessages,
});

describe('hasChatWorkInFlight', () => {
  it('is false when nothing runs and nothing is queued', () => {
    expect(hasChatWorkInFlight(state([]))).toBe(false);
    expect(hasChatWorkInFlight(state([op('sendMessage', 'completed')]))).toBe(false);
  });

  it('is true while a message is being saved', () => {
    expect(hasChatWorkInFlight(state([op('sendMessage', 'running')]))).toBe(true);
  });

  it('is true while a reply runs', () => {
    expect(hasChatWorkInFlight(state([op('execAgentRuntime', 'running')]))).toBe(true);
  });

  it('is true while follow-ups wait in a queue', () => {
    expect(hasChatWorkInFlight(state([], { main_agt_tpc: [{ id: 'q1' } as QueuedMessage] }))).toBe(
      true,
    );
  });

  it('ignores running operations unrelated to sending', () => {
    expect(hasChatWorkInFlight(state([op('translate', 'running')]))).toBe(false);
  });
});
