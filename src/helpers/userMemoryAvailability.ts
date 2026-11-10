import { useServerConfigStore } from '@/store/serverConfig';
import { type ServerConfigStore } from '@/store/serverConfig/store';

/**
 * Aico operator memory switch (`AICO_USER_MEMORY_ENABLED` on the server). Only an
 * explicit `false` turns memory off: an unhydrated config or an older server keeps
 * each user's and agent's own memory setting in charge. The server enforces the
 * switch on its own; the client only stops offering and fetching memory.
 */
const selectUserMemoryAllowed = (s: Partial<ServerConfigStore> | undefined) =>
  s?.serverConfig?.enableUserMemory !== false;

/** Non-React read, mirroring the `enableCloudSandbox` gate in the tool engine. */
export const isUserMemoryAllowedByServer = (): boolean => {
  if (typeof window === 'undefined') return true;

  return selectUserMemoryAllowed(window.global_serverConfigStore?.getState());
};

export const useUserMemoryAllowed = (): boolean =>
  useServerConfigStore(selectUserMemoryAllowed) !== false;
