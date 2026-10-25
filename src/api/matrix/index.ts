export { PodMatrixStore, type PodMatrixStoreOptions } from './PodMatrixStore';
export {
  canonicalStorageRoot,
  InMemoryMatrixRoomDirectory,
  SqlMatrixRoomDirectory,
  verifyRoomBinding,
  type MatrixRoomDirectory,
  type MatrixRoomDirectoryTransition,
  type MatrixRoomReference,
  type MatrixRoomReferenceInput,
  type VerifiedRoomBinding,
} from './MatrixRoomDirectory';
export {
  isMatrixUserId,
  isMatrixUserIdForWebId,
  MATRIX_STORAGE_BINDING_EVENT_TYPE,
  matrixUserIdForWebId,
} from './MatrixIdentity';
export { encodeSyncCursor, parseSyncCursor, type MatrixSyncCursor } from './MatrixSyncCursor';
export {
  createMatrixPodResolver,
  createMatrixStorageVerifier,
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
