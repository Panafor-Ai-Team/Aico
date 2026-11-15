import type { ChatStoreState } from '../initialState';
import {
  INPUT_LOADING_OPERATION_TYPES,
  type OperationType,
  QUEUE_BLOCKING_OPERATION_TYPES,
} from '../slices/operation/types';

const IN_FLIGHT_OPERATION_TYPES = new Set<OperationType>([
  ...INPUT_LOADING_OPERATION_TYPES,
  ...QUEUE_BLOCKING_OPERATION_TYPES,
]);

/**
 * Whether reloading the page now would lose chat work: a message being saved,
 * a reply running, or a voice upload. Follow-ups waiting in the queue are
 * persisted to localStorage (slices/operation/queueStorage), so a reload
 * restores them and must not pin the tab on stale chunks forever.
 */
export const hasChatWorkInFlight = (state: Pick<ChatStoreState, 'operations'>): boolean =>
  Object.values(state.operations).some(
    (operation) => operation.status === 'running' && IN_FLIGHT_OPERATION_TYPES.has(operation.type),
  );
