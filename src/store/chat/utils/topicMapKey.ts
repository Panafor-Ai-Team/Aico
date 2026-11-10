/**
 * Topic scope types
 * - 'agent': Agent main topic list (default when only agentId)
 * - 'group': Group main topic list (when groupId without agentId)
 * - 'group_agent': Agent topic list within a group (when both groupId and agentId)
 */
export type TopicMapScope = 'agent' | 'group' | 'group_agent';

export interface TopicMapKeyInput {
  /**
   * Agent ID - used for agent sessions or agent within group
   */
  agentId?: string;
  /**
   * Group ID - used for group sessions
   */
  groupId?: string;
  /**
   * Explicit scope override (auto-detected if not provided)
   */
  scope?: TopicMapScope;
}

/**
 * Generate a unique key for topic data map based on session context
 *
 * Auto-detection rules:
 * - If groupId && agentId: scope = 'group_agent'
 * - If groupId only: scope = 'group'
 * - If agentId only: scope = 'agent'
 *
 * Key format:
 * - Agent session: `agent_{agentId}`
 * - Group session: `group_{groupId}`
 * - Agent within group: `group_agent_{groupId}_{agentId}`
 */
export const topicMapKey = (input: TopicMapKeyInput): string => {
  const { agentId, groupId, scope: explicitScope } = input;

  // Auto-detect scope if not explicitly provided
  let scope: TopicMapScope;
  if (explicitScope) {
    scope = explicitScope;
  } else if (groupId && agentId) {
    scope = 'group_agent';
  } else if (groupId) {
    scope = 'group';
  } else {
    scope = 'agent';
  }

  switch (scope) {
    case 'group_agent': {
      return `group_agent_${groupId}_${agentId}`;
    }
    case 'group': {
      return `group_${groupId}`;
    }

    default: {
      return `agent_${agentId}`;
    }
  }
};

/**
 * Narrow a conversation context's `scope` to the values `topicMapKey` accepts as
 * an explicit override, dropping everything else (`main`, `thread`, `sub_agent`,
 * …) so auto-detection keeps handling those.
 *
 * Group runs MUST carry this through on every topic write. Auto-detection maps
 * agentId+groupId to `group_agent`, but a group's main topic row lives in the
 * `group_{groupId}` bucket — the one the sidebar renders. Patch the derived
 * bucket instead and the visible row never sees the update, so a finished group
 * chat keeps the run-start `status: 'running'` (and its spinner) until the next
 * refetch.
 */
export const resolveGroupTopicScope = (scope?: string): TopicMapScope | undefined =>
  scope === 'group' || scope === 'group_agent' ? scope : undefined;
