import { capabilitySelectors } from './selectors';
import { getServerConfigStoreState } from './store';

export type ClientCapability = keyof typeof capabilitySelectors;

/** Non-React read of an Aico capability flag; `false` until the server config is hydrated. */
export const isClientCapabilityEnabled = (capability: ClientCapability): boolean => {
  const state = getServerConfigStoreState();
  return state ? capabilitySelectors[capability](state) : false;
};
