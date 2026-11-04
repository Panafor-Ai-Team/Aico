import { capabilitySelectors, useServerConfigStore } from '@/store/serverConfig';
import { useUserStore } from '@/store/user';
import { labPreferSelectors } from '@/store/user/selectors';

/**
 * Projects are visible only when the operator enabled the `projects` capability (enforced
 * by the server) and the user turned the Labs toggle on.
 */
export const useProjectsEnabled = (): boolean => {
  const capability = useServerConfigStore(capabilitySelectors.projects);
  const labEnabled = useUserStore(labPreferSelectors.enableProjects);
  return capability && labEnabled;
};
