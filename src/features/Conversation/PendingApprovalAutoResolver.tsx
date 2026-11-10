'use client';

import isEqual from 'fast-deep-equal';
import { useEffect, useMemo } from 'react';

import { useChatStore } from '@/store/chat';
import { operationSelectors } from '@/store/chat/slices/operation/selectors';
import { useToolStore } from '@/store/tool';
import { toolSelectors } from '@/store/tool/selectors';

import { useConversationResourceAccess } from './hooks/useConversationResourceAccess';
import { canAutoApprovePendingIntervention } from './Messages/AssistantGroup/Tool/Detail/Intervention/autoApprove';
import { conversationSelectors, dataSelectors, useConversationStore } from './store';

// Shared across providers: the same topic can be mounted more than once (e.g.
// main chat and a side panel), and each tool call must be approved only once.
const dispatchedToolMessageIds = new Set<string>();

/**
 * Approves pending tool calls the user already granted (for the request or
 * for the whole chat). The runtime auto-runs new calls under a grant, but
 * calls that were already waiting in the same step stay pending; this resolves
 * them one at a time, each after the previous run has paused, so resumes never
 * race. Hard stops (see `canAutoApprovePendingIntervention`) keep their card.
 */
const PendingApprovalAutoResolver = () => {
  const context = useConversationStore((s) => s.context);
  const pendingInterventions = useConversationStore(dataSelectors.pendingInterventions, isEqual);
  const latestMessageId = useConversationStore(
    (s) => conversationSelectors.displayMessages(s).at(-1)?.id,
  );
  const approveToolCall = useConversationStore((s) => s.approveToolCall);
  const { canUseResource } = useConversationResourceAccess();

  const operationContext = useMemo(
    () => ({
      agentId: context.agentId,
      groupId: context.groupId,
      scope: context.scope,
      subAgentId: context.subAgentId,
      threadId: context.threadId ?? null,
      topicId: context.topicId ?? null,
    }),
    [
      context.agentId,
      context.groupId,
      context.scope,
      context.subAgentId,
      context.threadId,
      context.topicId,
    ],
  );
  const isRunning = useChatStore(
    operationSelectors.isAgentRuntimeRunningByContext(operationContext),
  );
  // Re-run when a grant is recorded or the chat flag changes.
  const requestGrants = useChatStore((s) => s.toolApprovalRequestGrants);
  const isChatGranted = useChatStore((s) => s.isChatToolApprovalGranted(context.topicId));

  useEffect(() => {
    if (!canUseResource || isRunning || pendingInterventions.length === 0) return;

    const chatStore = useChatStore.getState();
    const toolStore = useToolStore.getState();

    // Only the latest request: stale pending rows from an abandoned earlier
    // turn must not be resumed just because the chat is granted.
    const latestRequestRootId = latestMessageId
      ? chatStore.getRequestRootUserMessageId(latestMessageId)
      : undefined;
    if (!latestRequestRootId) return;

    const next = pendingInterventions.find(
      (item) =>
        !dispatchedToolMessageIds.has(item.toolMessageId) &&
        chatStore.getRequestRootUserMessageId(item.toolMessageId) === latestRequestRootId &&
        chatStore.isToolApprovalGranted({
          anchorMessageId: item.toolMessageId,
          topicId: context.topicId,
        }) &&
        canAutoApprovePendingIntervention({
          apiName: item.apiName,
          identifier: item.identifier,
          manifest: toolSelectors.getManifestById(item.identifier)(toolStore) as any,
          requestArgs: item.requestArgs,
        }),
    );
    if (!next) return;

    dispatchedToolMessageIds.add(next.toolMessageId);
    void approveToolCall(next.toolMessageId, next.assistantGroupId ?? '');
  }, [
    approveToolCall,
    canUseResource,
    context.topicId,
    isChatGranted,
    isRunning,
    latestMessageId,
    pendingInterventions,
    requestGrants,
  ]);

  return null;
};

export default PendingApprovalAutoResolver;
