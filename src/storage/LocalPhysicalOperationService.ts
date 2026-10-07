import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import {
  AuthorityExclusionError,
  SqliteAuthorityExclusionGate,
  authorityCoordinationDatabasePath,
  canonicalAuthorityRoot,
  isAuthorityThenable,
} from './AuthorityExclusionGate';
import { AuthorityPendingUnavailableError } from './AuthorityFreshnessService';

const sessionBrand: unique symbol = Symbol('local-physical-session');
/** Opaque admission identity; only its creating service can validate or consume it. */
export interface LocalPhysicalOperationSession { readonly [sessionBrand]: true }
interface SessionState {
  phase: 'active' | 'draining' | 'closed';
  drains: Set<Promise<void>>;
  callbacks: Set<Promise<unknown>>;
}

/** Owns one canonical Local physical domain and retains admission across actual producer drain. */
export class LocalPhysicalOperationService {
  public readonly canonicalRoot: string;
  public readonly databasePath: string;
  private readonly gate: SqliteAuthorityExclusionGate;
  private readonly context = new AsyncLocalStorage<LocalPhysicalOperationSession>();
  private readonly sessions = new WeakMap<LocalPhysicalOperationSession, SessionState>();
  private readonly operations = new Set<Promise<unknown>>();
  private stopped = false;
  private readonly finalizers: Array<() => void | Promise<void>> = [];
  private closePromise?: Promise<void>;

  public constructor(rootFilePath: string) {
    this.canonicalRoot = canonicalAuthorityRoot(rootFilePath);
    this.databasePath = authorityCoordinationDatabasePath(this.canonicalRoot);
    mkdirSync(path.dirname(this.databasePath), { recursive: true });
    this.gate = new SqliteAuthorityExclusionGate(this.databasePath);
  }

  public registerDrain(drained: Promise<void>, session = this.context.getStore()): void {
    const state = this.requireActive(session);
    // Rejection cannot establish producer completion. Keep admission refused in that case.
    const confirmed = drained.catch(() => new Promise<void>(() => undefined));
    state.drains.add(confirmed);
  }

  /** Wait inside an admitted producer callback before leaving its actual cleanup context. */
  public async awaitRegisteredDrains(): Promise<void> {
    const state = this.requireActive(this.context.getStore());
    while (true) {
      const current = [...state.drains];
      await Promise.all(current);
      if (current.length === state.drains.size) { return; }
    }
  }

  /** A violated synchronous capability has no qualified completion; keep its domain held. */
  public retainUnconfirmedProducer(): void {
    const state = this.requireActive(this.context.getStore());
    state.drains.add(new Promise<void>(() => undefined));
    this.stop();
  }

  public run<T>(callback: (session: LocalPhysicalOperationSession) => T | Promise<T>,
    session = this.context.getStore()): Promise<T> {
    if (session) {
      try {
        const state = this.requireActive(session);
        const nested = Promise.resolve(callback(session));
        state.callbacks.add(nested);
        void nested.then(() => state.callbacks.delete(nested), () => state.callbacks.delete(nested));
        return nested;
      }
      catch (error) { return Promise.reject(error); }
    }
    if (this.stopped) { return Promise.reject(this.unavailable('Local physical operations are stopped')); }
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    let delivered = false;
    const result = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    const operation = this.gate.runExclusive(async () => {
      if (this.stopped) { throw this.unavailable('Local physical operations are stopped'); }
      const admitted = this.createSession();
      const state = this.sessions.get(admitted)!;
      let outcome: { ok: true; value: T } | { ok: false; error: unknown };
      try { outcome = { ok: true, value: await this.context.run(admitted, () => callback(admitted)) }; }
      catch (error) { outcome = { ok: false, error }; }
      state.phase = 'draining';
      if (!outcome.ok) { delivered = true; reject(outcome.error); }
      await Promise.allSettled(state.callbacks);
      await Promise.all(state.drains);
      state.phase = 'closed';
      if (!outcome.ok) { throw outcome.error; }
      return outcome.value;
    });
    this.operations.add(operation);
    void operation.then(value => {
      this.operations.delete(operation);
      if (!delivered) { delivered = true; resolve(value); }
    }, error => {
      this.operations.delete(operation);
      if (!delivered) { reject(this.mapAdmissionError(error)); }
    });
    return result;
  }

  public runSync<T>(callback: (session: LocalPhysicalOperationSession) => T,
    session = this.context.getStore()): T {
    if (session) {
      this.requireActive(session);
      return this.requireSynchronous(callback(session));
    }
    if (this.stopped) { throw this.unavailable('Local physical operations are stopped'); }
    try {
      return this.gate.runExclusiveSync(() => {
        const admitted = this.createSession();
        const state = this.sessions.get(admitted)!;
        let value!: T;
        let failed = false;
        let error: unknown;
        try {
          value = this.context.run(admitted, () => this.requireSynchronous(callback(admitted)));
        } catch (caught) { failed = true; error = caught; }
        state.phase = 'draining';
        if (state.drains.size > 0 || state.callbacks.size > 0) {
          // The gate detects this thenable and retains its original transaction until drained.
          const drain = Promise.allSettled(state.callbacks).then(() => Promise.all(state.drains))
            .then(() => { state.phase = 'closed'; });
          this.operations.add(drain);
          void drain.then(() => this.operations.delete(drain));
          return drain as T;
        }
        state.phase = 'closed';
        if (failed) { throw error; }
        return value;
      });
    } catch (error) { throw this.mapAdmissionError(error); }
  }

  public registerFinalizer(finalize: () => void | Promise<void>): void {
    if (this.stopped) { throw this.unavailable('Local physical operations are stopped'); }
    this.finalizers.push(finalize);
  }

  /** Stop new admission immediately; active callbacks retain their producer drains. */
  public stop(): void { this.stopped = true; }

  public close(finalize?: () => void | Promise<void>): Promise<void> {
    if (this.closePromise) { return this.closePromise; }
    this.stop();
    this.closePromise = (async () => {
      while (this.operations.size > 0) { await Promise.allSettled([...this.operations]); }
      try { await this.gate.runExclusive(async () => {
        await finalize?.();
        for (const cleanup of this.finalizers) { await cleanup(); }
      }); }
      finally { await this.gate.close(); }
    })();
    return this.closePromise;
  }

  private requireSynchronous<T>(value: T): T {
    if (isAuthorityThenable(value)) {
      void Promise.resolve(value).catch(() => undefined);
      this.retainUnconfirmedProducer();
      throw this.unavailable('Synchronous Local operation returned a thenable');
    }
    return value;
  }

  private createSession(): LocalPhysicalOperationSession {
    const session: LocalPhysicalOperationSession = Object.freeze({ [sessionBrand]: true as const });
    this.sessions.set(session, { phase: 'active', drains: new Set(), callbacks: new Set() });
    return session;
  }

  private requireActive(session?: LocalPhysicalOperationSession): SessionState {
    const state = session && this.sessions.get(session);
    if (this.stopped || !state || state.phase !== 'active' || this.context.getStore() !== session) {
      throw this.unavailable('Local physical session is foreign, stale, draining or closed');
    }
    return state;
  }

  private unavailable(message: string): AuthorityPendingUnavailableError {
    return new AuthorityPendingUnavailableError(message);
  }

  private mapAdmissionError(error: unknown): unknown {
    return error instanceof AuthorityExclusionError ? this.unavailable(error.message) : error;
  }
}
