import { mutate } from '@/libs/swr';

/**
 * Revalidate the member allow-list right after a team-model grant change, so
 * the admin's own session (and every mounted selector sharing the SWR key —
 * chat and image pickers) adds/drops the model immediately instead of waiting
 * for the focus throttle or the poll interval. Only the allow-list: grant
 * toggles never change catalog rows.
 *
 * Fire-and-forget: if the revalidation fails, the regular refresh paths still
 * converge — this only shortens the wait.
 */
export const revalidateTeamModelAccess = (orgId: string): void => {
  void mutate(['aico-my-allowed-models', orgId]);
};
