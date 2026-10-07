import {
  LockingResourceStore as BaseLockingResourceStore,
  BasicRepresentation,
  ResourceIdentifier,
  Representation,
  Conditions,
  ChangeMap,
} from '@solid/community-server';
import type { AuxiliaryIdentifierStrategy, ExpiringReadWriteLocker, ResourceStore, RepresentationPreferences, Patch } from '@solid/community-server';
import type { Readable } from 'node:stream';
import { getLoggerFor } from 'global-logger-factory';
import { captureAuthorityDependency, authoritySnapshotContext, AuthorityDependencyRetryError, trackAuthorityRead } from './AuthoritySnapshotContext';
import { authorityResourceTracker } from './AuthorityResourceTracker';
import type { LocalPhysicalOperationService } from './LocalPhysicalOperationService';
import { deliverPhysicalResult, observePhysicalStream, runPhysicalOperation } from './LocalPhysicalStreamLifetime';
import { HierarchicalReadWriteLocker } from './HierarchicalReadWriteLocker';

/**
 * Locking store with a read lifecycle that can actually cancel a stalled GET before unlocking.
 *
 * The hierarchy locker (`HierarchicalReadWriteLocker`) never releases a lock by timeout: an arbitrary
 * locked callback has no cancel handle, and releasing it underneath a still-running callback would
 * let a conflicting writer in. That leaves the known GET representation lifecycle as the only place a
 * bounded stuck-read recovery belongs. This override keeps every CSS lock/auxiliary/stream behavior
 * and only corrects the order of teardown: on timeout it installs a completion listener on the real
 * stream **before** destroying it, then awaits an actual `close` acknowledgement. The lock is released
 * only when that acknowledgement arrives (or the stream already closed). A stream that never
 * acknowledges keeps the lock held, deliberately failing closed rather than synthesising a settlement.
 */
export class LockingResourceStore extends BaseLockingResourceStore {
  protected override logger = getLoggerFor(this);
  private readonly representationTimeoutMs: number;
  private readonly hierarchyLocks: ExpiringReadWriteLocker;
  private readonly permissionSource: ResourceStore;
  private readonly operationService?: LocalPhysicalOperationService;

  /**
   * @param source - Store to wrap.
   * @param locks - Locker shared with the scoped SPARQL handler.
   * @param auxiliaryStrategy - Maps auxiliary identifiers to their subject.
   * @param options - Read-stall timeout tuning.
   */
  public constructor(
    source: ResourceStore,
    locks: ExpiringReadWriteLocker,
    auxiliaryStrategy: AuxiliaryIdentifierStrategy,
    options: { representationTimeoutMs?: number; operationService?: LocalPhysicalOperationService } = {},
  ) {
    super(source, locks, auxiliaryStrategy);
    this.operationService = options.operationService;
    this.representationTimeoutMs = options.representationTimeoutMs ?? 6000;
    this.hierarchyLocks = locks;
    this.permissionSource = source;
  }

  /** Internal identity proof for guarded authority reads; does not expose the locker. */
  public usesAuthorityLocker(locks: ExpiringReadWriteLocker): boolean {
    return this.hierarchyLocks === locks;
  }

  override getLockIdentifier(identifier: ResourceIdentifier): ResourceIdentifier {
    // Guard against missing auxiliary strategy in custom wiring
    const hasAuxiliary = (this as any).auxiliaryStrategy?.isAuxiliaryIdentifier;
    const lockIdentifier = hasAuxiliary ? super.getLockIdentifier(identifier) : identifier;
    this.logger.debug(`getLockIdentifier: ${identifier.path} -> ${lockIdentifier.path}`);
    return lockIdentifier;
  }

  override async getRepresentation(
    identifier: ResourceIdentifier,
    preferences: RepresentationPreferences,
    conditions?: Conditions,
  ): Promise<Representation> {
    return deliverPhysicalResult(this.operationService, async () => {
      // Record the exact authority resource and the lock that protects it BEFORE the read, so a
      // concurrent ACL/ACR mutation during authorization makes the snapshot stale (including a 404).
      captureAuthorityDependency(identifier.path, this.getLockIdentifier(identifier).path);
      return await super.getRepresentation(identifier, preferences, conditions);
    }, value => observePhysicalStream(value.data));
  }

  override async hasResource(identifier: ResourceIdentifier): Promise<boolean> {
    const execute = async () => {
      captureAuthorityDependency(identifier.path, this.getLockIdentifier(identifier).path);
      const result = this.canUseHeldAuthorityLock(this.getLockIdentifier(identifier))
        ? this.permissionSource.hasResource(identifier) : super.hasResource(identifier);
      const state = authoritySnapshotContext.getStore();
      if (state) trackAuthorityRead(state, result);
      return await result;
    };
    return this.operationService ? this.operationService.run(execute) : execute();
  }

  private canUseHeldAuthorityLock(identifier: ResourceIdentifier): boolean {
    const state = authoritySnapshotContext.getStore();
    if (state?.phase !== 'fresh') return false;
    if (this.hierarchyLocks instanceof HierarchicalReadWriteLocker && this.hierarchyLocks.hasHeldReadLock(identifier)) return true;
    state.missingLocks.add(identifier.path);
    throw new AuthorityDependencyRetryError([...state.missingLocks]);
  }

  override async addResource(
    identifier: ResourceIdentifier,
    representation: Representation,
    conditions?: Conditions,
  ): Promise<ChangeMap> {
    return this.runPhysicalWrite(representation, async () => {
      this.logger.debug(`trying[addResource]: ${identifier.path}`);
      try {
        const result = await super.addResource(identifier, representation, conditions);
        this.logger.debug(`done[addResource]: ${identifier.path}`);
        return result;
      } catch (error) {
        this.logger.error(`locking: ${identifier.path}, ${error}`);
        throw error;
      } finally {
        this.logger.debug(`unlocked: ${identifier.path}`);
      }
    });
  }

  override async setRepresentation(
    identifier: ResourceIdentifier,
    representation: Representation,
    conditions?: Conditions,
  ): Promise<ChangeMap> {
    return this.runPhysicalWrite(representation, async () => {
      this.logger.debug(`trying[setRepresentation]: ${identifier.path}`);
      try {
        const result = await super.setRepresentation(identifier, representation, conditions);
        this.logger.debug(`done[setRepresentation]: ${identifier.path}`);
        return result;
      } catch (error) {
        this.logger.error(`locking: ${identifier.path}, ${error}`);
        throw error;
      } finally {
        this.logger.debug(`unlocked: ${identifier.path}`);
      }
    });
  }

  override deleteResource(identifier: ResourceIdentifier, conditions?: Conditions): Promise<ChangeMap> {
    const execute = (): Promise<ChangeMap> => super.deleteResource(identifier, conditions);
    return this.operationService ? this.operationService.run(execute) : execute();
  }

  override modifyResource(identifier: ResourceIdentifier, patch: Patch, conditions?: Conditions): Promise<ChangeMap> {
    const execute = (): Promise<ChangeMap> => super.modifyResource(identifier, patch, conditions);
    return this.operationService ? this.operationService.run(execute) : execute();
  }

  private runPhysicalWrite(representation: Representation, callback: () => Promise<ChangeMap>): Promise<ChangeMap> {
    return runPhysicalOperation(this.operationService, callback, representation.data);
  }

  /**
   * Resolve the representation externally as soon as it exists, but keep the read lock until the
   * stream is finished — including a real teardown when the read stalls.
   */
  protected override async lockedRepresentationRun(
    identifier: ResourceIdentifier,
    whileLocked: () => Promise<Representation>,
  ): Promise<Representation> {
    const authorityState = authoritySnapshotContext.getStore();
    const held = this.canUseHeldAuthorityLock(identifier);
    let confirmRead!: () => void;
    let failRead!: (error: unknown) => void;
    const actualRead = new Promise<void>((resolve, reject) => { confirmRead = resolve; failRead = reject; });
    void actualRead.catch(() => undefined);
    // Register the original internal read before the hierarchy/source can start. Caller timeout is
    // independent: a late representation still needs actual stream cleanup before physical release.
    this.operationService?.registerDrain(actualRead);
    return await new Promise<Representation>((resolve, reject) => {
      let representation: Representation | undefined;
      let outerSettled = false;
      let timedOut = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let cancelRead: () => void = () => undefined;
      const cancelled = new Promise<void>(resolveCancel => { cancelRead = resolveCancel; });

      const resetTimer = (): void => {
        if (timedOut) {
          return;
        }
        if (timer) {
          clearTimeout(timer);
        }
        timer = setTimeout(() => {
          timedOut = true;
          if (authorityState) authorityState.readFailure = new Error('Authority read did not complete normally');
          cancelRead();
          if (!outerSettled) {
            outerSettled = true;
            reject(new Error(`Timed out while reading ${identifier.path}`));
          }
        }, this.representationTimeoutMs);
      };
      resetTimer();

      const read = async(): Promise<void> => {
        // A request can expire while waiting in the lock queue. Once we finally hold the lock, do no
        // authority work for a caller that already left: deny the callback outright.
        if (timedOut) {
          if (timer) {
            clearTimeout(timer);
          }
          return;
        }
        try {
          representation = await whileLocked();
        } catch (error) {
          if (timer) {
            clearTimeout(timer);
          }
          if (!outerSettled) {
            outerSettled = true;
            reject(error);
          }
          return;
        }
        if (timedOut) {
          // The caller was already told the read timed out; a late representation is destroyed and
          // its teardown awaited before the lock can be released.
          await this.cancelStream(representation.data, authorityState ? new Error('Authority read timed out') : undefined);
          if (timer) {
            clearTimeout(timer);
          }
          return;
        }
        const wrapped = this.decorateRepresentation(representation, resetTimer);
        if (!outerSettled) {
          outerSettled = true;
          resolve(wrapped);
        }
        const outcome = await this.awaitReadCompletion(representation.data, cancelled, Boolean(authorityState));
        if (authorityState && outcome !== 'ended') authorityState.readFailure = new Error('Authority read did not complete normally');
        if (timer) {
          clearTimeout(timer);
        }
      };
      const completion = held ? read() : this.hierarchyLocks.withReadLock(identifier, read);
      void completion.then(confirmRead, failRead);
      const state = authoritySnapshotContext.getStore();
      if (state) trackAuthorityRead(state, completion);
      completion.catch((error: unknown) => {
        if (timer) {
          clearTimeout(timer);
        }
        if (!outerSettled) {
          outerSettled = true;
          reject(error);
        }
      });
    });
  }

  /**
   * Decorate the SAME stream object so every read resets the stall timer.
   *
   * An `Object.create(source, …)` facade reads the data but breaks the stream's `asyncIterator`
   * (a second, shadowed consumer) — the actual source ends and closes while the iterator hangs. Root
   * baseline `stream-facade-baseline.ts` proves decorating the real `read` keeps the async iterator
   * working, so the representation must carry the original source object and restore `read` once the
   * stream completes, so a late read cannot restart the timer.
   */
  private decorateRepresentation(representation: Representation, maintainLock: () => void): Representation {
    const source = representation.data;
    const originalRead = source.read;
    let complete = false;
    const patchedRead = function(this: unknown, size: number): unknown {
      if (!complete) {
        maintainLock();
      }
      return originalRead.call(source, size);
    };
    source.read = patchedRead;
    const restore = (): void => {
      complete = true;
      if (source.read === patchedRead) {
        source.read = originalRead;
      }
    };
    source.once('end', restore);
    source.once('close', restore);
    source.once('error', restore);
    return new BasicRepresentation(source, representation.metadata, representation.binary);
  }

  /**
   * Hold the lock until the stream ends normally or the interrupted read is actually torn down.
   *
   * `end`/`close` are normal completion. A spontaneous or external `error` is NOT completion: it goes
   * through the same acknowledged teardown as an explicit cancellation, so a writer cannot enter
   * while `_destroy` cleanup is still running. The `cancelled` signal (stall timeout) behaves the
   * same way. Only an acknowledged `ended` outcome releases the lock.
   */
  private async awaitReadCompletion(data: Readable, cancelled: Promise<void>, authorityRead = false): Promise<'ended' | 'errored' | 'cancelled'> {
    const outcome = await new Promise<'ended' | 'errored' | 'cancelled'>(resolve => {
      const onEnd = (): void => resolve('ended');
      const onClose = (): void => resolve(authorityRead && !data.readableEnded ? 'cancelled' : 'ended');
      const onError = (): void => resolve('errored');
      data.once('end', onEnd);
      data.once('close', onClose);
      data.once('error', onError);
      void cancelled.then(() => resolve('cancelled'));
    });
    if (outcome === 'ended') {
      return outcome;
    }
    await this.cancelStream(data, authorityRead && outcome === 'cancelled' ? new Error('Authority read timed out') : undefined);
    return outcome;
  }

  /**
   * Cancel a stream and await a real completion acknowledgement.
   *
   * The listener is attached before `destroy()` so a synchronous `close` cannot be missed. If the
   * stream never reports `close` (for example `emitClose: false` without another acknowledgement) the
   * awaiting callback never returns and the lock stays held — failing closed rather than releasing
   * while cleanup might still be running.
   */
  private async cancelStream(data: Readable, error?: Error): Promise<void> {
    const closed = data.closed ? undefined : new Promise<void>(resolveClose => { data.once('close', resolveClose); });
    // CSS arrayifyStream waits for end/error, not close. Signal even an already closed authority
    // stream; custom _destroy implementations may discard destroy(error)'s error argument.
    if (error) {
      try { data.emit('error', error); }
      catch (signalError) { this.logger.debug(`Authority cancellation listener threw: ${signalError instanceof Error ? signalError.message : String(signalError)}`); }
    }
    if (!closed) return;
    try {
      if (!data.destroyed) {
        data.destroy();
      }
    } catch (error) {
      this.logger.debug(`Stream destroy threw while cancelling: ${error instanceof Error ? error.message : String(error)}`);
    }
    await closed;
  }
}
