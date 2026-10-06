import {
  LockingResourceStore,
  type AuxiliaryIdentifierStrategy, type ChangeMap, type Conditions, type ExpiringReadWriteLocker,
  type IdentifierStrategy, type Patch, type Representation, type ResourceIdentifier, type ResourceStore,
} from '@solid/community-server';
import { metadataRequestContext } from './MetadataRequestContext';
import { LegacyStorageVersionError, storageVersionReadContext } from './StorageVersion';

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
      const state = { active: true };
      const renewals = new Set<() => void>();
      // Preparing a response can wait on an inner lock or a bounded backend
      // query. Once delivered, CSS's stream-read renewal and idle expiry apply.
      const timer = setInterval(() => { for (const renew of renewals) renew(); }, 1000);
      const acquire = async (index: number): Promise<Representation> => {
        if (!state.active) throw new Error('Resource read lock expired');
        return index === identifiers.length
          ? this.withFreshMetadata(() => storageVersionReadContext.run(true, action))
          : this.withPreparingReadLock(identifiers[index], () => acquire(index + 1), state, renewals);
      };
      try {
        return await acquire(0);
      } catch (error) {
        state.active = false;
        if (!(error instanceof LegacyStorageVersionError)) throw error;
        // acquire() has rejected only after every read lock was released. Never upgrade a held lock.
        await this.withMutationLocks(error.identifier, error.initialize);
      } finally {
        clearInterval(timer);
      }
    }
  }

  private withPreparingReadLock(
    identifier: ResourceIdentifier,
    action: () => Promise<Representation>,
    state: { active: boolean },
    renewals: Set<() => void>,
  ): Promise<Representation> {
    // Preserve CSS's split lifetime: return the representation immediately,
    // while its read lock remains held until the source stream ends or fails.
    return new Promise((resolve, reject) => {
      let representation: Representation | undefined;
      this.hierarchyLocks.withReadLock(identifier, async (maintainLock) => {
        if (!state.active) throw new Error('Resource read lock expired');
        renewals.add(maintainLock);
        try {
          representation = await action();
        } finally {
          renewals.delete(maintainLock);
        }
        if (!state.active) {
          representation.data.destroy();
          throw new Error('Resource read lock expired');
        }
        resolve(this.createExpiringRepresentation(representation, maintainLock));
        await this.waitForStreamToEnd(representation.data);
      }).catch((error: unknown) => {
        state.active = false;
        renewals.clear();
        representation?.data.destroy(error instanceof Error ? error : new Error(String(error)));
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
    const timer = setInterval(() => { for (const renew of renewals) renew(); }, 1000);
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
