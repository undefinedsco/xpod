import type { RunRecordData } from './store';

export type PersistedRunState = Pick<RunRecordData, 'status' | 'cancelRequestedAt' | 'completedAt' | 'updatedAt' | 'leaseOwner' | 'leaseExpiresAt'>;

/** Cancellation is monotonic across independent, stale API/runner writers. */
export function mergeRunCancellation(proposed: RunRecordData, current?: PersistedRunState): RunRecordData {
  const cancelRequestedAt = current?.cancelRequestedAt ?? proposed.cancelRequestedAt;
  if (cancelRequestedAt === undefined && current?.status !== 'cancelled') return { ...proposed };
  const cancelled = current?.status === 'cancelled' || proposed.status !== 'running' || current?.status !== 'running';
  return {
    ...proposed,
    cancelRequestedAt,
    ...(cancelled ? {
      status: 'cancelled', error: undefined, leaseOwner: undefined, leaseExpiresAt: undefined,
      completedAt: current?.completedAt ?? proposed.completedAt ?? Math.floor(Date.now() / 1000),
    } : {}),
  };
}
