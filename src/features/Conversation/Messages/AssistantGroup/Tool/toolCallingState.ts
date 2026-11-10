import { LOADING_FLAT } from '@lobechat/const';

export interface ToolCallingStateInput {
  /** A running `toolCalling` / `executeToolCall` operation carries this tool call's id. */
  hasRunningToolCallOperation: boolean;
  isArgumentsStreaming: boolean;
  isAssistantMessageBusy: boolean;
  isToolCallingFromOperation: boolean;
  result?: { content?: string | null; error?: unknown } | null;
}

/**
 * Whether a single tool call is still executing.
 *
 * The tool's own result is the source of truth for completion: the
 * message-level toolCalling flag stays true while sibling tools are still
 * running, so a finished tool must not flip back into "loading".
 *
 * The client runtime starts the `toolCalling` op without a `messageId` and keys
 * `executeToolCall` to the tool message, so message-level selectors can miss a
 * long-running tool (e.g. image generation). The per-tool-call operation
 * closes that gap — the tool message exists with empty content meanwhile.
 */
export const resolveIsToolCalling = ({
  hasRunningToolCallOperation,
  isArgumentsStreaming,
  isAssistantMessageBusy,
  isToolCallingFromOperation,
  result,
}: ToolCallingStateInput): boolean => {
  const hasError = !!result?.error;
  const hasFinishedResult =
    hasError || (!!result && result.content !== LOADING_FLAT && !!result.content);
  if (hasFinishedResult) return false;

  const looksLikeWaitingForToolResult = !isArgumentsStreaming;
  const isToolCallingFallback = looksLikeWaitingForToolResult && isAssistantMessageBusy;

  return isToolCallingFromOperation || isToolCallingFallback || hasRunningToolCallOperation;
};
