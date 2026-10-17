import {
  InternalServerError, LockingResourceStore,
  type AuxiliaryIdentifierStrategy, type ChangeMap, type Conditions, type ExpiringReadWriteLocker,
  type IdentifierStrategy, type Patch, type Representation, type ResourceIdentifier, type ResourceStore,
} from '@solid/community-server';
import { metadataRequestContext } from './MetadataRequestContext';
import { LegacyStorageVersionError, storageVersionReadContext } from './StorageVersion';

/**
 * How often a held ancestor lock is renewed while downstream lock acquisition or
 * representation creation is still pending. The production lease is 6s, so a 1s
 * cadence keeps every acquired layer alive without touching the lease budget.
 */
const PENDING_LOCK_RENEWAL_MS = 1000;

/**
 * Operation-local state for one root-first read acquisition. `pending` holds the
 * clear callbacks of every renewal interval currently running in the operation
 * so a single lost layer can stop all of them at once.
 */
interface ReadOperation {
  active: boolean;
  readonly pending: Set<() => void>;
  abort: () => void;
}

/** Root-first ancestor locks protect parent membership and empty-container deletion. */
export class HierarchyLockingResourceStore extends LockingResourceStore {
  public constructor(
    private readonly mutationSource: ResourceStore,
    private readonly hierarchyLocks: ExpiringReadWriteLocker,
    auxiliaryStrategy: AuxiliaryIdentifierStrategy,
    private readonly identifierStrategy: IdentifierStrategy,
  ) {
    super(mutationSource, hierarchyLocks, auxiliaryStrategy);
  }

  public override async setRepresentation(id: ResourceIdentifier, body: Representation, conditions?: Conditions): Promise<ChangeMap> {
    return this.withMutationLocks(id, () => this.mutationSource.setRepresentation(id, body, conditions));
  }

  public override async addResource(id: ResourceIdentifier, body: Representation, conditions?: Conditions): Promise<ChangeMap> {
    return this.withMutationLocks(id, () => this.mutationSource.addResource(id, body, conditions));
  }

  public override async deleteResource(id: ResourceIdentifier, conditions?: Conditions): Promise<ChangeMap> {
    return this.withMutationLocks(id, () => this.mutationSource.deleteResource(id, conditions));
  }

  public override async modifyResource(id: ResourceIdentifier, patch: Patch, conditions?: Conditions): Promise<ChangeMap> {
    return this.withMutationLocks(id, () => this.mutationSource.modifyResource(id, patch, conditions));
  }

  protected override async lockedRepresentationRun(id: ResourceIdentifier, action: () => Promise<Representation>): Promise<Representation> {
    const identifiers = [...this.ancestors(id), id];
    for (;;) {
      // Operation-local coordination for one acquisition attempt. The wrapped
      // lease race does not cancel the callback, so when any layer loses its
      // lease every still-pending renewal interval in this attempt must stop at
      // once, and any late lock callback must refuse to start a timer or run the
      // source action. A fresh operation is created inside the legacy retry loop
      // so an aborted attempt cannot poison the retry; it never crosses
      // operations or instances.
      const operation: ReadOperation = {
        active: true,
        pending: new Set(),
        abort(): void {
          if (!operation.active) return;
          operation.active = false;
          for (const stop of operation.pending) stop();
          operation.pending.clear();
        },
      };
      const acquire = (index: number): Promise<Representation> => {
        if (!operation.active) return Promise.reject(new InternalServerError('Resource read lock expired'));
        return index === identifiers.length
          ? this.withFreshMetadata(() => storageVersionReadContext.run(true, action))
          : this.readLockWithPendingRenewal(identifiers[index], operation, () => acquire(index + 1));
      };
      try {
        return await acquire(0);
      } catch (error) {
        if (!(error instanceof LegacyStorageVersionError)) throw error;
        // acquire() has rejected only after every read lock was released. Never upgrade a held lock.
        await this.withMutationLocks(error.identifier, error.initialize);
      }
    }
  }

  /**
   * Acquire a single layer's read lock and keep it alive while the downstream
   * acquisition and representation creation are still pending.
   *
   * The wrapped locker's lease race does not cancel the callback, so a slow
   * descendant can otherwise let an already-held ancestor lease expire before
   * the representation exists. Renewal starts only after this layer owns the
   * lock and stops as soon as a representation is produced, at which point the
   * original CSS stream-read renewal takes over. If any layer loses its lease
   * the whole operation aborts immediately: every pending interval is cleared
   * (even those whose callback is still blocked on a descendant), a late child
   * acquisition refuses to start a timer or the source, and any late
   * representation is destroyed so the physical lock releases. The original
   * error identity and release order are preserved.
   */
  private async readLockWithPendingRenewal(
    identifier: ResourceIdentifier,
    operation: ReadOperation,
    whileLocked: () => Promise<Representation>,
  ): Promise<Representation> {
    return new Promise((resolve, reject) => {
      let representation: Representation | undefined;
      let lost = false;
      this.hierarchyLocks.withReadLock(identifier, async (maintainLock: () => void) => {
        // A layer whose own or an ancestor's lease was already lost must not
        // start renewing or run the source even though its lock was granted late.
        if (!operation.active) throw new InternalServerError('Resource read lock expired');
        const pending = setInterval(maintainLock, PENDING_LOCK_RENEWAL_MS);
        const stopRenewal = (): void => { clearInterval(pending); operation.pending.delete(stopRenewal); };
        operation.pending.add(stopRenewal);
        try {
          representation = await whileLocked();
        } catch (error: unknown) {
          // Our own lease already rejected; swallow the late failure instead of
          // throwing a second rejection into the settled race.
          if (lost) return;
          throw error;
        } finally {
          stopRenewal();
        }
        // Our own lease was lost while the child was still pending: the late
        // representation must not be handed out, and must be destroyed so the
        // held lock releases.
        if (lost) {
          representation?.data.destroy(new InternalServerError('Resource read lock expired'));
          return;
        }
        // An ancestor lost its lease while this layer's descendant was pending:
        // destroy the late representation and settle this layer so nothing hangs.
        if (!operation.active) {
          representation.data.destroy(new InternalServerError('Resource read lock expired'));
          reject(new InternalServerError('Resource read lock expired'));
          return;
        }
        // A contract-violating source that resolves no representation must fail
        // visible: createExpiringRepresentation rejects with the same TypeError
        // the original CSS consumer produces, instead of leaving this pending.
        resolve(this.createExpiringRepresentation(representation, maintainLock));
        // Release the lock when an error occurs or the data finished streaming.
        await this.waitForStreamToEnd(representation.data);
      }).catch((error: unknown) => {
        // Stop every pending renewal interval in this operation on any loss.
        operation.abort();
        if (lost) return;
        lost = true;
        representation?.data.destroy(error instanceof Error ? error : new Error('Resource read lock lost'));
        reject(error);
      });
    });
  }

  private async withFreshMetadata<T>(action: () => Promise<T>): Promise<T> {
    // Permission/existence checks may have cached an older version before the lock was acquired.
    metadataRequestContext.getStore()?.metadataCache.clear();
    return metadataRequestContext.run({ metadataCache: new Map() }, action);
  }

  public async withMutationLocks<T>(identifier: ResourceIdentifier, action: () => Promise<T>): Promise<T> {
    const target = this.getLockIdentifier(identifier);
    const ancestors = this.ancestors(target);
    const identifiers = [...ancestors, target];
    const renewals = new Set<() => void>();
    let active = true;
    // Existing Local wrappers use leases of at least 6s; Cloud owner locks do not expire.
    const timer = setInterval(() => { for (const renew of renewals) renew(); }, PENDING_LOCK_RENEWAL_MS);
    const acquire = async (index: number): Promise<T> => {
      if (!active) throw new Error('Resource mutation lock expired');
      if (index === identifiers.length) return this.withFreshMetadata(() => storageVersionReadContext.run(false, action));
      const callback = async (renew: () => void): Promise<T> => {
        if (!active) throw new Error('Resource mutation lock expired');
        renewals.add(renew);
        try { return await acquire(index + 1); }
        finally { renewals.delete(renew); }
      };
      try {
        // PUT may create every missing ancestor. Conservatively serialize those metadata writes too.
        return await this.hierarchyLocks.withWriteLock(identifiers[index], callback);
      } catch (error) {
        active = false;
        throw error;
      }
    };
    try { return await acquire(0); }
    finally { active = false; clearInterval(timer); }
  }

  private ancestors(target: ResourceIdentifier): ResourceIdentifier[] {
    const ancestors: ResourceIdentifier[] = [];
    if (this.identifierStrategy.supportsIdentifier(target)) {
      let current = target;
      while (!this.identifierStrategy.isRootContainer(current)) {
        current = this.identifierStrategy.getParentContainer(current);
        ancestors.unshift(current);
      }
    }
    return ancestors;
  }
}
