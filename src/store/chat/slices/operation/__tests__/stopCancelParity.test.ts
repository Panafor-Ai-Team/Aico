/**
 * Parity between "show the Stop button" and "cancel what Stop targets".
 *
 * The input renders Stop when `isInputLoadingByContext` finds a running op in
 * the context's `messageMapKey` bucket, but `stopGenerating` cancels via
 * `cancelOperations`, which matches `op.context` field-by-field with `===`.
 *
 * `messageMapKey` normalises (`sub_agent` collapses into `main`; a topicless
 * `isNew: true` and a topicless `isNew: undefined` share one bucket) while the
 * strict filter does not. Wherever the two disagree the user sees a Stop button
 * that cancels nothing and the answer keeps streaming.
 */
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { operationSelectors } from '@/store/chat/slices/operation/selectors';
import type { OperationContext } from '@/store/chat/slices/operation/types';
import { INPUT_LOADING_OPERATION_TYPES } from '@/store/chat/slices/operation/types';
import { useChatStore } from '@/store/chat/store';

vi.mock('zustand/traditional');

/** The exact filter `stopGenerating` builds from the conversation context. */
const stopFilter = (context: OperationContext) => ({
  context: context as any,
  status: 'running' as const,
  type: INPUT_LOADING_OPERATION_TYPES,
});

describe('Stop button / cancel parity', () => {
  beforeEach(() => {
    act(() => {
      useChatStore.setState({
        operations: {},
        operationsByType: {} as any,
        operationsByMessage: {},
        operationsByContext: {},
        messageOperationMap: {},
      });
    });
  });

  /**
   * Runs one scenario: start an op under `opContext`, then check that the input
   * shows loading for `uiContext` and that Stop actually aborts the op.
   */
  const expectStopToCancel = (opContext: OperationContext, uiContext: OperationContext) => {
    const { result } = renderHook(() => useChatStore());

    let operationId = '';
    act(() => {
      operationId = result.current.startOperation({
        type: 'execAgentRuntime',
        context: opContext,
        label: 'AI Generation',
      }).operationId;
    });

    // Precondition: the input is in loading state, so the user sees Stop.
    expect(operationSelectors.isInputLoadingByContext(uiContext as any)(result.current)).toBe(true);

    act(() => {
      result.current.cancelOperations(stopFilter(uiContext), 'User cancelled');
    });

    const op = useChatStore.getState().operations[operationId];
    expect(op.status).toBe('cancelled');
    expect(op.abortController.signal.aborted).toBe(true);
  };

  it('cancels a plain same-context operation', () => {
    const context = { agentId: 'agt_1', topicId: 'tpc_1', threadId: null };

    expectStopToCancel(context, context);
  });

  it('cancels a topicless operation when the UI context is marked isNew', () => {
    // Both sides key to `main_agt_1_new`, so the Stop button is showing — but
    // the op carries no `isNew`, and the filter demands `isNew === true`.
    expectStopToCancel(
      { agentId: 'agt_1', topicId: null, threadId: null },
      { agentId: 'agt_1', topicId: null, threadId: null, isNew: true },
    );
  });

  /**
   * The other half of the invariant: widening the match must not let Stop reach
   * into a conversation the user isn't looking at.
   */
  const expectStopToSpare = (opContext: OperationContext, uiContext: OperationContext) => {
    const { result } = renderHook(() => useChatStore());

    let operationId = '';
    act(() => {
      operationId = result.current.startOperation({
        type: 'execAgentRuntime',
        context: opContext,
        label: 'AI Generation',
      }).operationId;
    });

    act(() => {
      result.current.cancelOperations(stopFilter(uiContext), 'User cancelled');
    });

    const op = useChatStore.getState().operations[operationId];
    expect(op.status).toBe('running');
    expect(op.abortController.signal.aborted).toBe(false);
  };

  it('spares a creating thread when stopping the main conversation in the same topic', () => {
    expectStopToSpare(
      { agentId: 'agt_1', topicId: 'tpc_1', threadId: null, scope: 'thread', isNew: true },
      { agentId: 'agt_1', topicId: 'tpc_1', threadId: null },
    );
  });

  it('spares another topic in the same agent', () => {
    expectStopToSpare(
      { agentId: 'agt_1', topicId: 'tpc_2', threadId: null },
      { agentId: 'agt_1', topicId: 'tpc_1', threadId: null },
    );
  });

  it('spares an existing thread when stopping the main conversation', () => {
    expectStopToSpare(
      { agentId: 'agt_1', topicId: 'tpc_1', threadId: 'thd_1' },
      { agentId: 'agt_1', topicId: 'tpc_1', threadId: null },
    );
  });

  it('cancels a sub_agent-scoped operation from the main conversation', () => {
    // `messageMapKey` folds `sub_agent` into `main`, so both sides key to
    // `main_agt_1_tpc_1` — but the filter compares the raw scope strings.
    expectStopToCancel(
      { agentId: 'agt_1', topicId: 'tpc_1', threadId: null, scope: 'sub_agent' },
      { agentId: 'agt_1', topicId: 'tpc_1', threadId: null, scope: 'main' },
    );
  });
});
