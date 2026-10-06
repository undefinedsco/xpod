import type { ExpiringReadWriteLocker, PromiseOrValue, ResourceIdentifier } from '@solid/community-server';
import { UrlAwareRedisLocker, type UrlAwareRedisLockerOptions } from './UrlAwareRedisLocker';

/**
 * Destructive lifecycle barriers must outlive their actual writer callbacks.
 * Keys never expire and startup/shutdown never clears another process's locks.
 * After a crash, operators must stop/reconcile all writers before removing a
 * stranded key. Automatic expiry or stealing would permit overlapping writes.
 */
export class PodLifecycleRedisLocker extends UrlAwareRedisLocker implements ExpiringReadWriteLocker {
  private readonly active = new Set<Promise<unknown>>();
  private closing = false;
  private shutdown?: Promise<void>;

  public constructor(options: UrlAwareRedisLockerOptions = {}) {
    super({ ...options, namespacePrefix: `${options.namespacePrefix ?? ''}pod-lifecycle:` });
  }

  public override async initialize(): Promise<void> {
    if (this.closing) { throw new Error('Pod lifecycle locker is closing'); }
    await super.initialize();
  }

  public override async withReadLock<T>(
    identifier: ResourceIdentifier,
    action: (maintainLock: () => void) => PromiseOrValue<T>,
  ): Promise<T> {
    return this.track(() => super.withReadLock(identifier, action));
  }

  public override async withWriteLock<T>(
    identifier: ResourceIdentifier,
    action: (maintainLock: () => void) => PromiseOrValue<T>,
  ): Promise<T> {
    return this.track(() => super.withWriteLock(identifier, action));
  }

  public override async finalize(): Promise<void> {
    this.closing = true;
    this.shutdown ??= (async () => {
      await Promise.allSettled([...this.active]);
      await super.finalize();
    })();
    return this.shutdown;
  }

  private async track<T>(run: () => Promise<T>): Promise<T> {
    if (this.closing) { throw new Error('Pod lifecycle locker is closing'); }
    const pending = run();
    this.active.add(pending);
    try { return await pending; } finally { this.active.delete(pending); }
  }
}
