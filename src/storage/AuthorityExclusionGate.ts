import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { getLoggerFor } from 'global-logger-factory';
import { performance } from 'node:perf_hooks';

import { getSqliteRuntime, type SqliteDatabase } from './SqliteRuntime';

/**
 * Typed, in-process product surface for the qualified SQLite authority-exclusion semantics.
 *
 * A dedicated physical coordination database is opened through the repository's public
 * `getSqliteRuntime`. `BEGIN IMMEDIATE` is held across the complete awaited callback; the
 * acquisition deadline is a submission-time monotonic absolute deadline (timer dispatch is only a
 * prompt), busy/locked refusal uses actual backend codes, and any thrown value (including
 * `undefined`/`null`) rolls back and rejects with the original value.
 *
 * This is a physical-root primitive. It does not coordinate another database's revoke/rotate, raw
 * filesystem writers, stale native indexes, HTTP authorization, network filesystems, lost-response
 * provenance, or host power loss.
 */

export class AuthorityExclusionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'AuthorityExclusionError';
  }
}

export class AuthorityExclusionTimeoutError extends AuthorityExclusionError {
  public constructor(message: string) {
    super(message);
    this.name = 'AuthorityExclusionTimeoutError';
  }
}

export class AuthorityExclusionClosedError extends AuthorityExclusionError {
  public constructor(message: string) {
    super(message);
    this.name = 'AuthorityExclusionClosedError';
  }
}

export class AuthorityExclusionBusyError extends AuthorityExclusionError {
  public constructor() { super('authority exclusion gate is busy'); this.name = 'AuthorityExclusionBusyError'; }
}

export class AuthorityExclusionPoisonedError extends AuthorityExclusionError {
  public constructor(public override readonly cause: unknown) {
    super('authority exclusion release is unconfirmed');
    this.name = 'AuthorityExclusionPoisonedError';
  }
}

export interface AuthorityExclusionOptions {
  /** Delay between busy retries, in ms. */
  retryDelayMs?: number;
  /** Default acquisition timeout, in ms. */
  defaultTimeoutMs?: number;
}

export interface AuthorityExclusionRunOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface AuthorityExclusionGate {
  readonly databasePath: string;
  runExclusive<T>(callback: () => Promise<T> | T, options?: AuthorityExclusionRunOptions): Promise<T>;
  runExclusiveSync<T>(callback: () => T): T;
  close(): Promise<void>;
}

const BUSY_ERRCODES = new Set<number>([5, 6]);
const BUSY_CODES = new Set<string>(['SQLITE_BUSY', 'SQLITE_LOCKED']);

function isBusyError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const record = error as Record<string, unknown>;
  for (const key of ['errcode', 'code', 'errno']) {
    const value = record[key];
    if (typeof value === 'number' && BUSY_ERRCODES.has(value)) {
      return true;
    }
    if (typeof value === 'string' && BUSY_CODES.has(value)) {
      return true;
    }
  }
  return false;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason !== undefined ? signal.reason : new AuthorityExclusionError('authority exclusion request aborted');
}

const MEMORY_VFS_NAMES = new Set<string>(['memdb']);

/** Decode SQLite URI `%HH` escapes without throwing on a literal `%`. */
function decodeSqliteUriPercent(value: string): string {
  return value.replace(/%([0-9A-Fa-f]{2})/gu, (_match, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)));
}

interface ParsedSqliteFileUri {
  path: string;
  params: URLSearchParams;
}

/**
 * Parse a `file:` URI per SQLite syntax: strip the ignored `#fragment` first, split the query at
 * the first `?`, drop a `//authority` component, then percent-decode the path. `%3F` therefore stays
 * part of the filename rather than becoming a query delimiter.
 */
function parseSqliteFileUri(databasePath: string): ParsedSqliteFileUri {
  let rest = databasePath.slice('file:'.length);
  const fragmentIndex = rest.indexOf('#');
  if (fragmentIndex !== -1) {
    rest = rest.slice(0, fragmentIndex);
  }
  const queryIndex = rest.indexOf('?');
  const rawPath = queryIndex === -1 ? rest : rest.slice(0, queryIndex);
  const rawQuery = queryIndex === -1 ? '' : rest.slice(queryIndex + 1);
  let pathPart = rawPath;
  if (pathPart.startsWith('//')) {
    const afterAuthority = pathPart.slice(2);
    const pathStart = afterAuthority.indexOf('/');
    pathPart = pathStart === -1 ? '' : afterAuthority.slice(pathStart);
  }
  return { path: decodeSqliteUriPercent(pathPart), params: new URLSearchParams(rawQuery) };
}

/**
 * True when a SQLite database name cannot provide cross-process physical exclusion: the literal
 * `:memory:` name, a temporary (empty-name) database, or a genuine `file:` URI selecting an in-memory
 * database via `mode=memory` or a memory VFS (`vfs=memdb`).
 *
 * URI parameters apply ONLY to `file:` URIs (SQLite official URI syntax), so an ordinary on-disk
 * filename that merely contains `?mode=memory` or `?vfs=memdb` is a normal persistent file.
 */
export function isInMemoryDatabasePath(databasePath: string): boolean {
  if (typeof databasePath !== 'string') {
    return false;
  }
  const trimmed = databasePath.trim();
  if (trimmed === '' || trimmed === ':memory:') {
    return true;
  }
  if (!/^file:/iu.test(trimmed)) {
    return false;
  }
  const { path: databaseName, params } = parseSqliteFileUri(trimmed);
  if ((params.get('mode') ?? '').toLowerCase() === 'memory') {
    return true;
  }
  if (MEMORY_VFS_NAMES.has((params.get('vfs') ?? '').toLowerCase())) {
    return true;
  }
  const normalized = databaseName.replace(/^\/+/u, '');
  return normalized === '' || normalized === ':memory:';
}

function assertPersistentDatabasePath(databasePath: unknown): asserts databasePath is string {
  if (typeof databasePath !== 'string' || databasePath.trim() === '' || isInMemoryDatabasePath(databasePath)) {
    throw new AuthorityExclusionError(
      'authority exclusion requires a persistent on-disk coordination database path',
    );
  }
}

function validateTimingOption(name: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new AuthorityExclusionError(`${name} must be a finite nonnegative number`);
  }
  return value;
}

interface WaitSlot {
  resolve: (outcome: { ok: true; value: unknown } | { ok: false; error: unknown }) => void;
  callback: () => Promise<unknown> | unknown;
  deadlineAt: number;
  timeoutMs: number;
  signal?: AbortSignal;
  done: boolean;
  active: boolean;
  aborted: boolean;
  retryTimer: NodeJS.Timeout | null;
  timer: NodeJS.Timeout;
  cleanup: () => void;
}

/** A process-scoped exclusion gate over one physical coordination database. */
export class SqliteAuthorityExclusionGate implements AuthorityExclusionGate {
  protected readonly logger = getLoggerFor(this);

  private readonly db: SqliteDatabase;
  private readonly retryDelayMs: number;
  private readonly defaultTimeoutMs: number;
  private readonly slots = new Map<symbol, WaitSlot>();
  private closeRequested = false;
  private syncActive = false;
  private poisoned?: AuthorityExclusionPoisonedError;
  private closeResult: Promise<void> | undefined;

  public constructor(public readonly databasePath: string, options: AuthorityExclusionOptions = {}) {
    // Validate the persistence and timing contract before allocating any database handle.
    assertPersistentDatabasePath(databasePath);
    this.retryDelayMs = validateTimingOption('retryDelayMs', options.retryDelayMs ?? 5);
    this.defaultTimeoutMs = validateTimingOption('defaultTimeoutMs', options.defaultTimeoutMs ?? 5000);
    this.db = getSqliteRuntime().openDatabase(databasePath);
    this.db.pragma('busy_timeout = 0');
  }

  public runExclusive<T>(callback: () => Promise<T> | T, options: AuthorityExclusionRunOptions = {}): Promise<T> {
    if (typeof callback !== 'function') {
      return Promise.reject(new AuthorityExclusionError('callback must be a function'));
    }
    if (this.poisoned) { return Promise.reject(this.poisoned); }
    if (this.closeRequested) {
      return Promise.reject(new AuthorityExclusionClosedError('authority exclusion gate is closed'));
    }
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      return Promise.reject(new AuthorityExclusionError('timeoutMs must be a finite nonnegative number'));
    }
    const signal = options.signal;
    if (signal?.aborted) {
      return Promise.reject(abortReason(signal));
    }

    const slotId = Symbol('authority-exclusion');
    let resolveSlot!: WaitSlot['resolve'];
    const caller = new Promise<{ ok: true; value: unknown } | { ok: false; error: unknown }>((resolve) => {
      resolveSlot = resolve;
    });

    const deadlineAt = performance.now() + timeoutMs;
    const onAbort = (): void => this.markAborted(slotId);
    const timer = setTimeout(() => this.markExpired(slotId), timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    const slot: WaitSlot = {
      resolve: resolveSlot,
      callback,
      deadlineAt,
      timeoutMs,
      signal,
      done: false,
      active: false,
      aborted: false,
      retryTimer: null,
      timer,
      cleanup: () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (slot.retryTimer) {
          clearTimeout(slot.retryTimer);
        }
      },
    };
    this.slots.set(slotId, slot);

    this.attemptHead();

    return caller.then((outcome) => {
      if (outcome.ok) {
        return outcome.value as T;
      }
      throw outcome.error;
    });
  }

  public runExclusiveSync<T>(callback: () => T): T {
    if (this.poisoned) { throw this.poisoned; }
    if (this.closeRequested) { throw new AuthorityExclusionClosedError('authority exclusion gate is closed'); }
    if (this.syncActive || this.slots.size > 0) { throw new AuthorityExclusionBusyError(); }
    try { this.db.exec('BEGIN IMMEDIATE'); } catch (error) {
      if (isBusyError(error)) { throw new AuthorityExclusionBusyError(); }
      throw error;
    }
    this.syncActive = true;
    let outcome: { ok: true; value: T } | { ok: false; error: unknown };
    try { outcome = { ok: true, value: callback() }; } catch (error) { outcome = { ok: false, error }; }
    if (outcome.ok && isAuthorityThenable(outcome.value)) {
      // An accidentally asynchronous callback must not release its physical admission early.
      void Promise.resolve(outcome.value).then(() => undefined, () => undefined).then(() => {
        try { this.db.exec('ROLLBACK'); } catch (releaseError) { this.poison(releaseError); }
        finally { this.syncActive = false; this.attemptHead(); }
      });
      throw new AuthorityExclusionError('synchronous authority callback returned a thenable');
    }
    try {
      this.db.exec(outcome.ok ? 'COMMIT' : 'ROLLBACK');
    } catch (releaseError) {
      const error = this.poison(releaseError, outcome.ok ? undefined : outcome);
      throw error;
    } finally { this.syncActive = false; }
    this.attemptHead();
    if (!outcome.ok) { throw outcome.error; }
    return outcome.value;
  }

  private poison(releaseError: unknown, callbackOutcome?: { error: unknown }): AuthorityExclusionPoisonedError {
    this.poisoned = new AuthorityExclusionPoisonedError(callbackOutcome === undefined
      ? releaseError : new AggregateError([callbackOutcome.error, releaseError], 'authority callback and release failed'));
    for (const [id, slot] of this.slots) {
      if (!slot.active) { this.refuseSlot(id, this.poisoned); }
    }
    return this.poisoned;
  }

  public close(): Promise<void> {
    if (this.closeResult) {
      return this.closeResult;
    }
    this.closeRequested = true;
    const drain = async (): Promise<void> => {
      while (this.slots.size > 0 || this.syncActive) {
        this.attemptHead();
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      this.db.close();
    };
    this.closeResult = drain();
    return this.closeResult;
  }

  private headSlotId(): symbol | undefined {
    return this.slots.keys().next().value as symbol | undefined;
  }

  private settleSlot(
    slotId: symbol,
    outcome: { ok: true; value: unknown } | { ok: false; error: unknown },
  ): void {
    const slot = this.slots.get(slotId);
    if (!slot) {
      return;
    }
    this.slots.delete(slotId);
    slot.done = true;
    slot.cleanup();
    slot.resolve(outcome);
  }

  private refuseSlot(slotId: symbol, error: unknown): void {
    this.settleSlot(slotId, { ok: false, error });
  }

  private scheduleRetry(slotId: symbol): void {
    const slot = this.slots.get(slotId);
    if (!slot || slot.done || slot.retryTimer) {
      return;
    }
    slot.retryTimer = setTimeout(() => {
      slot.retryTimer = null;
      this.attemptHead();
    }, this.retryDelayMs);
  }

  private attemptHead(): void {
    const slotId = this.headSlotId();
    if (this.syncActive || slotId === undefined) {
      return;
    }
    const slot = this.slots.get(slotId)!;
    if (slot.done || slot.active) {
      return;
    }
    if (this.poisoned) { this.refuseSlot(slotId, this.poisoned); return; }
    if (slot.aborted) {
      this.refuseSlot(slotId, abortReason(slot.signal ?? new AbortController().signal));
      return;
    }
    // Timer dispatch is only a prompt; an overdue timer that has not fired must still refuse here.
    if (performance.now() >= slot.deadlineAt) {
      this.refuseSlot(slotId, new AuthorityExclusionTimeoutError(
        `authority exclusion refused: could not acquire the write lock within ${slot.timeoutMs}ms`,
      ));
      return;
    }
    if (this.closeRequested) {
      this.refuseSlot(slotId, new AuthorityExclusionClosedError('authority exclusion gate is closed'));
      return;
    }
    if (slot.retryTimer) {
      return;
    }
    slot.active = true;
    void this.admitAndCommit(slotId);
  }

  private async admitAndCommit(slotId: symbol): Promise<void> {
    const slot = this.slots.get(slotId);
    if (!slot) {
      return;
    }
    try {
      this.db.exec('BEGIN IMMEDIATE');
    } catch (error) {
      slot.active = false;
      if (isBusyError(error)) {
        this.scheduleRetry(slotId);
      } else {
        this.settleSlot(slotId, { ok: false, error });
        this.attemptHead();
      }
      return;
    }
    // Admitted: hold BEGIN IMMEDIATE across the whole awaited callback.
    try {
      const value = await slot.callback();
      this.settleCallback(slotId, { ok: true, value });
    } catch (error) {
      // Any thrown value (including undefined/null) is a failure and must roll back.
      this.settleCallback(slotId, { ok: false, error });
    }
  }

  private settleCallback(
    slotId: symbol,
    outcome: { ok: true; value: unknown } | { ok: false; error: unknown },
  ): void {
    let releaseOutcome = outcome;
    try { this.db.exec(outcome.ok ? 'COMMIT' : 'ROLLBACK'); } catch (releaseError) {
      releaseOutcome = { ok: false, error: this.poison(releaseError, outcome.ok ? undefined : outcome) };
    }
    this.settleSlot(slotId, releaseOutcome);
    this.attemptHead();
  }

  private markExpired(slotId: symbol): void {
    const slot = this.slots.get(slotId);
    if (!slot || slot.done || slot.active) {
      return;
    }
    slot.cleanup();
    this.refuseSlot(slotId, new AuthorityExclusionTimeoutError(
      `authority exclusion refused: could not acquire the write lock within ${slot.timeoutMs}ms`,
    ));
    this.attemptHead();
  }

  private markAborted(slotId: symbol): void {
    const slot = this.slots.get(slotId);
    if (!slot || slot.done || slot.active || slot.aborted) {
      return;
    }
    slot.aborted = true;
    slot.cleanup();
    this.refuseSlot(slotId, abortReason(slot.signal ?? new AbortController().signal));
    this.attemptHead();
  }
}

/**
 * Resolve the internal coordination database path from an authoritative storage root, outside
 * copied/replaced Pod directories. No new user configuration is introduced.
 */
export function authorityCoordinationDatabasePath(rootFilePath: string): string {
  const canonical = canonicalAuthorityRoot(rootFilePath);
  const key = createHash('sha256').update(canonical).digest('hex');
  return path.join(path.dirname(canonical), '.xpod-control', 'authority-coordination', key, 'exclusion.sqlite');
}

/** Resolve existing aliases while allowing an as-yet uncreated source root. */
export function canonicalAuthorityRoot(rootFilePath: string): string {
  let current = path.resolve(rootFilePath);
  const suffix: string[] = [];
  for (;;) {
    try { return path.join(realpathSync(current), ...suffix); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; }
      const parent = path.dirname(current);
      if (parent === current) { throw error; }
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}

export function isAuthorityThenable(value: unknown): value is PromiseLike<unknown> {
  return value !== null && (typeof value === 'object' || typeof value === 'function')
    && typeof (value as { then?: unknown }).then === 'function';
}
