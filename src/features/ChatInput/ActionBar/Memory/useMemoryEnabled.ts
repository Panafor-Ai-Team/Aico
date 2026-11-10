import { useUserMemoryAllowed } from '@/helpers/userMemoryAvailability';
import { useAgentStore } from '@/store/agent';
import { chatConfigByIdSelectors } from '@/store/agent/selectors';
import { useUserStore } from '@/store/user';
import { settingsSelectors } from '@/store/user/selectors';

/**
 * Returns the effective memory enabled state for an agent.
 * The operator switch (server config) wins; then agent-level config, then the user-level setting.
 */
export const useMemoryEnabled = (agentId: string): boolean => {
  const agentMemoryEnabled = useAgentStore(
    (s) => chatConfigByIdSelectors.getMemoryToolConfigById(agentId)(s)?.enabled,
  );
  const userMemoryEnabled = useUserStore(settingsSelectors.memoryEnabled);
  const userMemoryAllowed = useUserMemoryAllowed();

  return userMemoryAllowed && (agentMemoryEnabled ?? userMemoryEnabled);
};
