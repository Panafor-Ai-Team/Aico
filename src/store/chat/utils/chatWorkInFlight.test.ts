import { describe, expect, it } from 'vitest';

import type { Operation } from '../slices/operation/types';
import { hasChatWorkInFlight } from './chatWorkInFlight';

const op = (type: Operation['type'], status: Operation['status']) =>
  ({ id: `${type}-${status}`, status, type }) as Operation;

const state = (operations: Operation[]) => ({
  operations: Object.fromEntries(operations.map((item) => [item.id, item])),
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

  it('does not count a persisted queue as in-flight work', () => {
    // Queues survive a reload via localStorage, so blocking the stale-chunk
    // reload on them would leave the tab on a broken chunk forever.
    expect(hasChatWorkInFlight(state([op('sendMessage', 'completed')]))).toBe(false);
  });

  it('ignores running operations unrelated to sending', () => {
    expect(hasChatWorkInFlight(state([op('translate', 'running')]))).toBe(false);
  });
});
