import type { ChatTopic, UIChatMessage, UserInterventionConfig } from '@lobechat/types';

import { type ChatStore } from '@/store/chat/store';
import { type StoreSetter } from '@/store/types';
import { toolInterventionSelectors } from '@/store/user/selectors';
import { getUserStoreState } from '@/store/user/store';

/**
 * Tool approval grants.
 *
 * - `request`: the user approved a tool call; every later call of the same
 *   request (the run started by one user message) is auto-approved. Kept in
 *   memory, keyed by the request's root user message id.
 * - `chat`: the user chose "Always approve in this chat"; stored on the topic
 *   (`metadata.autoApproveTools`) so it covers every later request in that
 *   topic only.
 *
 * A grant turns the effective approval mode into `auto-run`, so the runtime's
 * hard stops (security blacklist, `always` policies) still ask.
 */
export type ToolApprovalScope = 'chat' | 'request';

interface ToolApprovalTarget {
  /** Any message of the request (usually the tool message being approved). */
  anchorMessageId?: string;
  topicId?: string | null;
}

/**
 * Walk the parent chain from `anchorMessageId` to the user message that
 * started the request. Returns the anchor itself when it is a user message.
 */
export const findRequestRootUserMessageId = (
  messagesById: Map<string, UIChatMessage>,
  anchorMessageId: string,
): string | undefined => {
  const visitedIds = new Set<string>();
  let currentMessageId: string | undefined = anchorMessageId;

  while (currentMessageId && !visitedIds.has(currentMessageId)) {
    visitedIds.add(currentMessageId);

    const message = messagesById.get(currentMessageId);
    if (!message) return;
    if (message.role === 'user') return message.id;

    currentMessageId = message.parentId;
  }
};

type Setter = StoreSetter<ChatStore>;
export const toolApproval = (set: Setter, get: () => ChatStore, _api?: unknown) =>
  new ToolApprovalActionImpl(set, get, _api);

export class ToolApprovalActionImpl {
  readonly #get: () => ChatStore;
  readonly #set: Setter;

  constructor(set: Setter, get: () => ChatStore, _api?: unknown) {
    void _api;
    this.#set = set;
    this.#get = get;
  }

  #findTopic = (topicId: string): ChatTopic | undefined => {
    for (const data of Object.values(this.#get().topicDataMap)) {
      const topic = data?.items?.find((item) => item.id === topicId);
      if (topic) return topic;
    }
  };

  #getRequestRootId = (anchorMessageId: string): string | undefined => {
    const messagesById = new Map<string, UIChatMessage>();
    for (const messages of Object.values(this.#get().dbMessagesMap)) {
      for (const message of messages) {
        if (!messagesById.has(message.id)) messagesById.set(message.id, message);
      }
    }
    return findRequestRootUserMessageId(messagesById, anchorMessageId);
  };

  getRequestRootUserMessageId = (anchorMessageId: string): string | undefined =>
    this.#getRequestRootId(anchorMessageId);

  isChatToolApprovalGranted = (topicId?: string | null): boolean => {
    if (!topicId) return false;
    return this.#findTopic(topicId)?.metadata?.autoApproveTools === true;
  };

  isToolApprovalGranted = ({ anchorMessageId, topicId }: ToolApprovalTarget): boolean => {
    if (this.isChatToolApprovalGranted(topicId)) return true;
    if (!anchorMessageId) return false;

    const rootId = this.#getRequestRootId(anchorMessageId);
    return !!rootId && !!this.#get().toolApprovalRequestGrants[rootId];
  };

  /**
   * Record a grant before the approved run resumes, so the resumed run (and
   * any later resume of the same request) picks it up. The chat grant is
   * written optimistically to the topic; the request grant already covers the
   * current run while that write is in flight.
   */
  grantToolApproval = (
    scope: ToolApprovalScope,
    { anchorMessageId, topicId }: ToolApprovalTarget,
  ) => {
    const rootId = anchorMessageId ? this.#getRequestRootId(anchorMessageId) : undefined;
    if (rootId && !this.#get().toolApprovalRequestGrants[rootId]) {
      this.#set(
        { toolApprovalRequestGrants: { ...this.#get().toolApprovalRequestGrants, [rootId]: true } },
        false,
        'grantToolApproval/request',
      );
    }

    if (scope === 'chat' && topicId) {
      this.#get()
        .updateTopicMetadata(topicId, { autoApproveTools: true })
        .catch((error) => console.error('[grantToolApproval] failed to save chat grant:', error));
    }
  };

  revokeChatToolApproval = async (topicId: string): Promise<void> => {
    await this.#get().updateTopicMetadata(topicId, { autoApproveTools: false });
  };

  /**
   * Approval config for a run that starts or resumes at `anchorMessageId`.
   * Both the client and the gateway transports call this instead of reading
   * the user settings directly.
   */
  resolveUserInterventionConfig = (target: ToolApprovalTarget): UserInterventionConfig => {
    const userStore = getUserStoreState();
    const config: UserInterventionConfig = {
      allowList: toolInterventionSelectors.allowList(userStore),
      approvalMode: toolInterventionSelectors.approvalMode(userStore),
    };

    if (config.approvalMode !== 'auto-run' && this.isToolApprovalGranted(target)) {
      return { ...config, approvalMode: 'auto-run' };
    }

    return config;
  };
}

export type ToolApprovalAction = Pick<ToolApprovalActionImpl, keyof ToolApprovalActionImpl>;
