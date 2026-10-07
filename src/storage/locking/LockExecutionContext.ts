import { AsyncLocalStorage } from 'node:async_hooks';
export interface LockLeaseGuard {
  failure?: Error;
  assertOwned: () => Promise<void>;
  onLoss?: (error: Error) => void;
}
interface LockExecution {
  leases: Set<LockLeaseGuard>;
  controller: AbortController;
  failure?: Error;
}
const execution = new AsyncLocalStorage<LockExecution>();
export function assertLockContextActive(): void {
  const current = execution.getStore();
  const failure = current?.failure ?? [...current?.leases ?? []].find(lease => lease.failure)?.failure;
  if (failure) throw failure;
}
/** Legacy direct access has no Redis context; this does not create a new authority path. */
export async function assertCurrentLockOwnership(): Promise<void> {
  assertLockContextActive();
  const current = execution.getStore();
  if (current) await Promise.all([...current.leases].map(lease => lease.assertOwned()));
  assertLockContextActive();
}
export function currentLockCancellationSignal(): AbortSignal | undefined {
  return execution.getStore()?.controller.signal;
}
export async function withLockLease<T>(lease: LockLeaseGuard, callback: () => T | Promise<T>): Promise<T> {
  const current: LockExecution = execution.getStore() ?? { leases: new Set<LockLeaseGuard>(), controller: new AbortController() };
  lease.onLoss = error => {
    current.failure ??= error;
    current.controller.abort(current.failure);
  };
  current.leases.add(lease);
  try {
    return await execution.run(current, async() => {
      await assertCurrentLockOwnership();
      const result = await callback();
      await assertCurrentLockOwnership();
      return result;
    });
  } finally {
    current.leases.delete(lease);
    lease.onLoss = undefined;
  }
}
