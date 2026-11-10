import { TRPCError } from '@trpc/server';

import { aicoEnv } from '@/envs/aico';

/**
 * Aico operator switch for user memory (`AICO_USER_MEMORY_ENABLED=0` turns it off).
 *
 * Off means memory is not used anywhere: no memory tool, no topic retrieval, no
 * persona injection, no extraction. Stored memories and every user's/agent's own
 * memory setting are left untouched, so turning the switch back on restores the
 * previous behaviour. Reading or deleting stored memories stays available.
 */
export const isUserMemoryEnabled = (): boolean => aicoEnv.AICO_USER_MEMORY_ENABLED !== false;

export const USER_MEMORY_DISABLED_MESSAGE = 'User memory is turned off on this server.';

/** Throws `PRECONDITION_FAILED` while the operator has memory turned off. */
export const assertUserMemoryEnabled = () => {
  if (!isUserMemoryEnabled()) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: USER_MEMORY_DISABLED_MESSAGE });
  }
};
