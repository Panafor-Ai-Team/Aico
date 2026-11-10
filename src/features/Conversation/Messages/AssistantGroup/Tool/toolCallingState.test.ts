import { LOADING_FLAT } from '@lobechat/const';
import { describe, expect, it } from 'vitest';

import { resolveIsToolCalling, type ToolCallingStateInput } from './toolCallingState';

const input = (overrides: Partial<ToolCallingStateInput> = {}): ToolCallingStateInput => ({
  hasRunningToolCallOperation: false,
  isArgumentsStreaming: false,
  isAssistantMessageBusy: false,
  isToolCallingFromOperation: false,
  result: undefined,
  ...overrides,
});

describe('resolveIsToolCalling', () => {
  it('treats a running per-tool-call operation as executing even when message-level selectors miss it', () => {
    // Client runtime: empty tool message exists, `toolCalling` op has no messageId.
    expect(
      resolveIsToolCalling(input({ hasRunningToolCallOperation: true, result: { content: '' } })),
    ).toBe(true);
  });

  it('is executing while the result is still the loading placeholder', () => {
    expect(
      resolveIsToolCalling(
        input({ hasRunningToolCallOperation: true, result: { content: LOADING_FLAT } }),
      ),
    ).toBe(true);
  });

  it('follows the message-level toolCalling operation', () => {
    expect(resolveIsToolCalling(input({ isToolCallingFromOperation: true }))).toBe(true);
  });

  it('falls back to the busy assistant message when arguments are complete', () => {
    expect(resolveIsToolCalling(input({ isAssistantMessageBusy: true }))).toBe(true);
    expect(
      resolveIsToolCalling(input({ isArgumentsStreaming: true, isAssistantMessageBusy: true })),
    ).toBe(false);
  });

  it('stops executing once the tool has its own result, even if siblings keep running', () => {
    expect(
      resolveIsToolCalling(
        input({
          hasRunningToolCallOperation: true,
          isToolCallingFromOperation: true,
          result: { content: 'Generated 1 image' },
        }),
      ),
    ).toBe(false);
    expect(
      resolveIsToolCalling(
        input({
          hasRunningToolCallOperation: true,
          result: { content: '', error: { message: 'x' } },
        }),
      ),
    ).toBe(false);
  });

  it('is idle when nothing is running', () => {
    expect(resolveIsToolCalling(input({ result: { content: '' } }))).toBe(false);
  });
});
