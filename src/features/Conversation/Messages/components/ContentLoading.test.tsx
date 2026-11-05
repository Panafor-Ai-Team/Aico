/**
 * @vitest-environment happy-dom
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import ContentLoading from './ContentLoading';

let mockRunningOp: Record<string, any> | undefined;

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key} ${JSON.stringify(options)}` : key,
  }),
}));

vi.mock('@/store/chat', () => ({
  useChatStore: (selector: (state: unknown) => unknown) => selector({}),
}));

vi.mock('@/store/chat/selectors', () => ({
  operationSelectors: {
    getDeepestRunningOperationByMessage: () => () => mockRunningOp,
  },
}));

const streamRetry = { attempt: 2, error: 'InternalServerError', maxAttempts: 2 };

describe('ContentLoading stream retry label', () => {
  afterEach(() => {
    cleanup();
    mockRunningOp = undefined;
  });

  it('does not call a normal chat retry an external agent being busy', () => {
    mockRunningOp = {
      metadata: { startTime: Date.now(), streamRetry },
      status: 'running',
      type: 'callLLM',
    };

    render(<ContentLoading id="msg-1" />);

    const label = screen.getByText(/operation\.streamRetry/).textContent ?? '';
    expect(label).toContain('operation.streamRetry.chat.withAttempt');
    expect(label).toContain('"attempt":2');
    expect(label).toContain('"maxAttempts":2');
    expect(label).not.toContain('heterogeneousAgentFallback');
  });

  it('keeps the agent name and status for heterogeneous agent retries', () => {
    mockRunningOp = {
      metadata: { heterogeneousType: 'claude-code', startTime: Date.now(), streamRetry },
      status: 'running',
      type: 'execHeterogeneousAgent',
    };

    render(<ContentLoading id="msg-1" />);

    const label = screen.getByText(/operation\.streamRetry/).textContent ?? '';
    expect(label).toContain('operation.streamRetry.withAttempt');
    expect(label).toContain('"status":"InternalServerError"');
  });
});
