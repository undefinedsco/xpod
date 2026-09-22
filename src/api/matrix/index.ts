export { PodMatrixStore, type MatrixAgentGrant, type PodMatrixStoreOptions } from './PodMatrixStore';
export { MatrixError } from './MatrixError';
export {
  InMemoryMatrixEventJournal,
  SqlMatrixEventJournal,
  type MatrixEventJournal,
  type MatrixTransactionReservation,
} from './MatrixEventJournal';
export {
  createMatrixPodResolver,
  resolveMatrixContext,
  type MatrixPodResolver,
} from './MatrixPodResolver';
export type {
  MatrixAccountInfo,
  MatrixClientEvent,
  MatrixCreateRoomRequest,
  MatrixEventRecord,
  MatrixRoomRecord,
  MatrixSendEventRequest,
  MatrixStore,
  MatrixStoreContext,
  MatrixSyncResponse,
} from './types';
