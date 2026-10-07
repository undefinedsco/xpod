import type { ExpiringReadWriteLocker, PromiseOrValue, ReadWriteLocker, ResourceIdentifier } from '@solid/community-server';

/** Adapts a non-expiring local locker without releasing live callbacks on a timer. */
export class PodLifecycleLocker implements ExpiringReadWriteLocker {
  public constructor(private readonly source: ReadWriteLocker) {}

  public async withReadLock<T>(identifier: ResourceIdentifier, action: (maintainLock: () => void) => PromiseOrValue<T>): Promise<T> {
    return this.source.withReadLock(identifier, () => action(() => {}));
  }

  public async withWriteLock<T>(identifier: ResourceIdentifier, action: (maintainLock: () => void) => PromiseOrValue<T>): Promise<T> {
    return this.source.withWriteLock(identifier, () => action(() => {}));
  }
}
