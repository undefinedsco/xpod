import { getLoggerFor } from 'global-logger-factory';
import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  ExpiringReadWriteLocker,
  IdentifierStrategy,
  ReadWriteLocker,
  ResourceIdentifier,
} from '@solid/community-server';

/** Safety cap on the ancestor chain; a real Pod layout is nowhere near this deep. */
const MAX_DEPTH = 64;
type LockMode = 'read' | 'write';
interface PlannedLock {
  identifier: ResourceIdentifier;
  mode: LockMode;
  depth: number;
  ancestors: string[];
}

/**
 * A read/write locker that locks a resource's whole ancestor chain and then the resource itself.
 *
 * The CSS `ResourceStore` locks only the exact request URL. That is enough to serialise two writes to
 * the *same* document, but not a scoped SPARQL UPDATE on a container against an ordinary LDP write to
 * one daily document inside that container: the two operations touch different URLs, so one writer can
 * commit while the other is still in its read-modify-write window. This wrapper closes the window by
 * taking a **shared** lock on every ancestor from the root down to (but not including) the resource,
 * and the resource's read or write lock last. Everyone acquires in the same root-to-leaf order, so a
 * scope WRITE excludes any descendant write through the shared ancestor, while two disjoint
 * descendants still only share the ancestor READ and may proceed independently.
 *
 * The same instance must be injected wherever the scope is locked — the ordinary
 * `ResourceStore_Locking` and the scoped SPARQL handler — otherwise the two sides would use different
 * lock spaces and not exclude each other. It implements {@link ExpiringReadWriteLocker} so it is a
 * drop-in replacement for the CSS `ResourceLocker`, and it only ever calls the underlying locker it
 * wraps (never itself), avoiding recursion.
 *
 * `maintainLock` is a no-op and **no lock is ever released by a timeout**. An arbitrary locked
 * callback has no cancel handle, so a `Promise.race` that rejects the caller while the callback still
 * runs would let a conflicting writer in underneath it (the old `WrappedExpiringReadWriteLocker`
 * bug). The hierarchy therefore holds the raw underlying locks until the callback actually settles.
 * Bounded recovery for a stalled GET belongs where the read lifecycle is known — the
 * `ResourceStore_Locking` override — which can cancel and await a real stream teardown before its
 * callback returns and the lock is released. Writes have no stall timeout at all.
 */
export class HierarchicalReadWriteLocker implements ExpiringReadWriteLocker {
  protected readonly logger = getLoggerFor(this);
  private readonly locker: ReadWriteLocker;
  private readonly identifierStrategy: IdentifierStrategy;
  private readonly heldPlans = new AsyncLocalStorage<{ active: boolean; locks: ReadonlyMap<string, LockMode> }>();

  /** Only this instance can mint a live plan; parent coverage follows the identifier strategy. */
  public hasHeldReadLock(identifier: ResourceIdentifier): boolean {
    const held = this.heldPlans.getStore();
    if (!held?.active) return false;
    if (held.locks.has(identifier.path)) return true;
    return this.lockChain(identifier).some(parent => held.locks.get(parent.path) === 'write');
  }

  /**
   * @param locker - The underlying locker that actually holds the locks.
   * @param identifierStrategy - Resolves a resource's parent containers.
   */
  public constructor(locker: ReadWriteLocker, identifierStrategy: IdentifierStrategy) {
    this.locker = locker;
    this.identifierStrategy = identifierStrategy;
  }

  public async withReadLock<T>(
    identifier: ResourceIdentifier,
    whileLocked: (maintainLock: () => void) => T | Promise<T>,
  ): Promise<T> {
    return await this.runLocked(this.lockChain(identifier), 'read', whileLocked);
  }

  public async withWriteLock<T>(
    identifier: ResourceIdentifier,
    whileLocked: (maintainLock: () => void) => T | Promise<T>,
  ): Promise<T> {
    return await this.runLocked(this.lockChain(identifier), 'write', whileLocked);
  }

  /** Hold the write scope and all local policy dependencies in one ordered plan. */
  public async withWriteLockAndReadDependencies<T>(
    identifier: ResourceIdentifier,
    dependencies: readonly ResourceIdentifier[],
    whileLocked: (maintainLock: () => void) => T | Promise<T>,
  ): Promise<T> {
    return await this.withLockAndReadDependencies(identifier, dependencies, 'write', whileLocked);
  }

  /**
   * Read-only sibling of {@link withWriteLockAndReadDependencies}: hold the scope READ plus every
   * discovered authority dependency, in one deterministic root-to-leaf plan. Retained for read-only
   * serialization where descendants cannot be introduced. The bounded observation uses the WRITE
   * variant instead, because an actual LDP writer newly creating a descendant holds only child WRITE +
   * ancestor READ, which a scope READ cannot exclude.
   */
  public async withReadLockAndReadDependencies<T>(
    identifier: ResourceIdentifier,
    dependencies: readonly ResourceIdentifier[],
    whileLocked: (maintainLock: () => void) => T | Promise<T>,
  ): Promise<T> {
    return await this.withLockAndReadDependencies(identifier, dependencies, 'read', whileLocked);
  }

  private async withLockAndReadDependencies<T>(
    identifier: ResourceIdentifier,
    dependencies: readonly ResourceIdentifier[],
    scopeMode: LockMode,
    whileLocked: (maintainLock: () => void) => T | Promise<T>,
  ): Promise<T> {
    const locks = new Map<string, PlannedLock>();
    const addChain = (target: ResourceIdentifier, mode: LockMode): void => {
      const chain = this.lockChain(target);
      for (const [depth, item] of chain.entries()) {
        const itemMode = depth === chain.length - 1 ? mode : 'read';
        const previous = locks.get(item.path);
        if (previous) {
          if (previous.depth !== depth) throw new Error(`Inconsistent lock ancestry for ${item.path}`);
          if (itemMode === 'write') previous.mode = 'write';
        } else {
          locks.set(item.path, { identifier: item, mode: itemMode, depth,
            ancestors: chain.slice(0, depth).map(ancestor => ancestor.path) });
        }
      }
    };
    // Resolve every chain before acquiring anything, including invalid dependencies.
    addChain(identifier, scopeMode);
    for (const dependency of dependencies) addChain(dependency, 'read');
    const plan = [...locks.values()]
      .filter(lock => !lock.ancestors.some(ancestor => locks.get(ancestor)?.mode === 'write'))
      .sort((a, b) => a.depth - b.depth || (a.identifier.path < b.identifier.path ? -1 :
        a.identifier.path > b.identifier.path ? 1 : 0));
    return await this.runLockPlan(plan, whileLocked);
  }

  /**
   * Resolve and validate the full root-to-leaf chain **before** acquiring anything.
   *
   * The chain is a safety boundary: if it cannot be proven complete (a parent lookup throws, it does
   * not make progress, re-enters a node, or exceeds the depth cap) the operation must fail closed
   * instead of running with an incomplete ancestor set. A truncated chain would let a writer slip
   * past a held scope lock, which is exactly the race this class exists to prevent. A legitimate root
   * identifier is a single-element chain.
   */
  private lockChain(identifier: ResourceIdentifier): ResourceIdentifier[] {
    const chain: ResourceIdentifier[] = [ identifier ];
    const seen = new Set<string>([ identifier.path ]);
    let current = identifier;
    while (!this.identifierStrategy.isRootContainer(current)) {
      if (chain.length > MAX_DEPTH) {
        throw new Error(`Refusing to lock ${identifier.path}: ancestor chain exceeds ${MAX_DEPTH} levels`);
      }
      let parent: ResourceIdentifier;
      try {
        parent = this.identifierStrategy.getParentContainer(current);
      } catch (error) {
        throw new Error(
          `Refusing to lock ${identifier.path}: cannot resolve the parent of ${current.path} (${error instanceof Error ? error.message : String(error)})`,
        );
      }
      if (parent.path === current.path || seen.has(parent.path)) {
        throw new Error(`Refusing to lock ${identifier.path}: ancestor chain re-enters ${parent.path}`);
      }
      seen.add(parent.path);
      chain.unshift(parent);
      current = parent;
    }
    return chain;
  }

  /**
   * Acquire the chain root-to-leaf inside nested callbacks, so every inner lock is released only
   * after the locked function (and every shallower lock) has settled. Every level uses the raw
   * underlying locker: no timeout may release a lock while its callback is still running.
   */
  private async runLocked<T>(
    chain: ResourceIdentifier[],
    mode: 'read' | 'write',
    whileLocked: (maintainLock: () => void) => T | Promise<T>,
  ): Promise<T> {
    return await this.runLockPlan(chain.map((identifier, index) => ({
      identifier, mode: index === chain.length - 1 ? mode : 'read',
    })), whileLocked);
  }

  private async runLockPlan<T>(
    plan: readonly Pick<PlannedLock, 'identifier' | 'mode'>[],
    whileLocked: (maintainLock: () => void) => T | Promise<T>,
    index = 0,
  ): Promise<T> {
    if (index === plan.length) {
      const held = { active: true, locks: new Map(plan.map(lock => [lock.identifier.path, lock.mode])) };
      return await this.heldPlans.run(held, async() => {
        try { return await whileLocked(() => undefined); }
        finally { held.active = false; }
      });
    }
    const { identifier, mode } = plan[index];
    const next = (): Promise<T> => this.runLockPlan(plan, whileLocked, index + 1);
    return mode === 'write' ? await this.locker.withWriteLock(identifier, next) :
      await this.locker.withReadLock(identifier, next);
  }
}
