/**
 * Permission-only authority-dependency collection.
 *
 * During authorization the CSS permission reader / authorizer read ACL or ACR resources (possibly
 * mapping an auxiliary `.acl`/`.acr` to its subject for locking). This async-local state records the
 * *exact* authority resource that was consulted and the lock resource it maps to, together with the
 * resource's mutation snapshot at that moment. The scoped write then acquires all recorded lock
 * resources in one deterministic plan and reads current authority again before mutating.
 *
 * Collection is only active inside an authorization attempt; ordinary reads and legacy queries are
 * unaffected. A dependency is recorded once per attempt so the snapshot reflects the first read even
 * if a later read hits a warm cache.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { authorityResourceTracker, type AuthorityResourceSnapshot } from './AuthorityResourceTracker';

export interface AuthorityDependency {
  /** The exact authority resource consulted (for example a `.acl`/`.acr` file), not its subject. */
  resourceUri: string;
  /** The resource whose lock protects that authority resource (the subject for an auxiliary ACL). */
  lockUri: string;
  /** The captured mutation snapshot; a later change makes the authorization stale. */
  snapshot: AuthorityResourceSnapshot;
}

export interface AuthoritySnapshotState {
  dependencies: Map<string, AuthorityDependency>;
  phase: 'discovery' | 'fresh';
  coversLock?: (lockUri: string) => boolean;
  missingLocks: Set<string>;
  pendingReads: Set<Promise<unknown>>;
  readFailure?: Error;
}

/** Internal pre-mutation retry, never a denied graph that may be silently filtered. */
export class AuthorityDependencyRetryError extends Error {
  public constructor(public readonly lockUris: readonly string[]) {
    super('The held authority plan does not cover a permission dependency');
  }
}

export const authoritySnapshotContext = new AsyncLocalStorage<AuthoritySnapshotState>();

export function newAuthoritySnapshotState(coversLock?: (lockUri: string) => boolean): AuthoritySnapshotState {
  return { dependencies: new Map(), phase: coversLock ? 'fresh' : 'discovery', coversLock,
    missingLocks: new Set(), pendingReads: new Set() };
}

/**
 * Record one authority dependency for the active attempt. The first snapshot for a resource is kept,
 * so a warm-cache re-read cannot refresh (and thus hide) a change. Does nothing when no attempt is
 * collecting — permission-only, so ordinary reads pay nothing.
 */
export function captureAuthorityDependency(resourceUri: string, lockUri: string): void {
  const state = authoritySnapshotContext.getStore();
  if (!state) {
    return;
  }
  if (!state.dependencies.has(resourceUri)) state.dependencies.set(resourceUri, {
    resourceUri,
    lockUri,
    snapshot: authorityResourceTracker.snapshot(resourceUri),
  });
  // The outer locking store owns auxiliary-to-subject mapping; lower accessors retain that mapping.
  const dependencyLock = state.dependencies.get(resourceUri)!.lockUri;
  if (state.phase === 'fresh' && !state.coversLock?.(dependencyLock)) {
    state.missingLocks.add(dependencyLock);
    throw new AuthorityDependencyRetryError([...state.missingLocks]);
  }
}

/** Wait for actual stream teardown as well as permission-reader completion. */
export async function settleAuthorityReads(state: AuthoritySnapshotState): Promise<void> {
  while (state.pendingReads.size) {
    const reads = [...state.pendingReads];
    const results = await Promise.allSettled(reads);
    for (const [index, result] of results.entries()) {
      state.pendingReads.delete(reads[index]);
      if (result.status === 'rejected') state.readFailure ??= result.reason instanceof Error
        ? result.reason : new Error('Authority read failed');
    }
  }
  if (state.missingLocks.size) throw new AuthorityDependencyRetryError([...state.missingLocks]);
  if (state.readFailure) throw state.readFailure;
}

/** Preserve a swallowed rejection and keep its asynchronous work in the permission drain. */
export function trackAuthorityRead(state: AuthoritySnapshotState, read: Promise<unknown>): void {
  state.pendingReads.add(read);
  void read.then(() => state.pendingReads.delete(read), error => {
    state.readFailure ??= error instanceof Error ? error : new Error('Authority read failed');
    state.pendingReads.delete(read);
  });
}

/** Run `callback` while dependencies are collected into `state`. */
export function collectAuthorityDependencies<T>(
  state: AuthoritySnapshotState,
  callback: () => Promise<T>,
): Promise<T> {
  return authoritySnapshotContext.run(state, callback);
}

/** Whether every recorded dependency is still at its captured generation with no active mutation. */
export function authorityDependenciesFresh(state: AuthoritySnapshotState): boolean {
  for (const dependency of state.dependencies.values()) {
    if (!authorityResourceTracker.isFresh(dependency.resourceUri, dependency.snapshot)) {
      return false;
    }
  }
  return true;
}
