import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AuthorityExclusionError,
  SqliteAuthorityExclusionGate,
} from '../../src/storage/AuthorityExclusionGate';
import { getSqliteRuntime } from '../../src/storage/SqliteRuntime';
import type { SqliteDatabase } from '../../src/storage/sqlite/types';
import { authoritySqlitePeerAdmission as peerAdmission } from '../helpers/AuthoritySqlitePeer';

// Root-owned public behavior oracles. The cast permits the regression to fail before the new API exists.
type ImmediateGate = SqliteAuthorityExclusionGate & {
  runExclusiveSync<T>(callback: () => T): T;
};

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function observed<T>(promise: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  return promise.then(value => ({ ok: true, value }), error => ({ ok: false, error }));
}

describe('Root synchronous authority admission and uncertain release', () => {
  let root: string;
  let databasePath: string;

  beforeEach(async () => {
    const parent = path.resolve('.test-data/authority-sync-admission');
    await mkdir(parent, { recursive: true });
    root = await mkdtemp(path.join(parent, 'root-'));
    databasePath = path.join(root, 'coordination.sqlite');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it.each([ 'bun', 'node' ] as const)('returns a healthy materialized result while excluding a real %s peer', async runtime => {
    const gate = new SqliteAuthorityExclusionGate(databasePath) as ImmediateGate;
    try {
      expect(typeof gate.runExclusiveSync).toBe('function');
      const result = gate.runExclusiveSync(() => {
        expect(peerAdmission(runtime, databasePath)).toBe(false);
        return [ { subject: 'messages.ttl#msg-id', value: 42 } ];
      });
      expect(result).toEqual([ { subject: 'messages.ttl#msg-id', value: 42 } ]);
      expect(peerAdmission(runtime, databasePath)).toBe(true);
    } finally {
      await gate.close();
    }
  });

  it('refuses synchronous entry during an active owner and its queued writer without bypassing FIFO', async () => {
    const gate = new SqliteAuthorityExclusionGate(databasePath) as ImmediateGate;
    const entered = deferred();
    const release = deferred();
    const writerEntered = deferred();
    const writerRelease = deferred();
    const order: string[] = [];
    const holder = observed(gate.runExclusive(async () => {
      order.push('owner'); entered.resolve(); await release.promise;
    }));
    let writer: ReturnType<typeof observed> | undefined;
    let syncCalls = 0;
    try {
      await entered.promise;
      writer = observed(gate.runExclusive(async () => {
        order.push('writer'); writerEntered.resolve(); await writerRelease.promise;
      }));
      expect(() => gate.runExclusiveSync(() => { syncCalls += 1; })).toThrow(AuthorityExclusionError);
      expect(syncCalls).toBe(0);
      release.resolve();
      await writerEntered.promise;
      expect(() => gate.runExclusiveSync(() => { syncCalls += 1; })).toThrow(AuthorityExclusionError);
      expect(syncCalls).toBe(0);
      writerRelease.resolve();
      expect((await writer).ok).toBe(true);
      expect(gate.runExclusiveSync(() => { order.push('sync'); return 42; })).toBe(42);
      expect(order).toEqual([ 'owner', 'writer', 'sync' ]);
    } finally {
      release.resolve(); writerRelease.resolve();
      await holder; await writer; await gate.close();
    }
  });

  it('refuses sync entry when a same-instance waiter is queued behind a real SQLite peer', async () => {
    const peer = getSqliteRuntime().openDatabase(databasePath);
    peer.pragma('busy_timeout = 0');
    const gate = new SqliteAuthorityExclusionGate(databasePath) as ImmediateGate;
    let peerHolding = false;
    let queued: ReturnType<typeof observed> | undefined;
    try {
      peer.exec('BEGIN IMMEDIATE'); peerHolding = true;
      let queuedCalls = 0;
      queued = observed(gate.runExclusive(() => { queuedCalls += 1; }, { timeoutMs: 2000 }));
      let syncCalls = 0;
      expect(() => gate.runExclusiveSync(() => { syncCalls += 1; })).toThrow(AuthorityExclusionError);
      expect(syncCalls).toBe(0); expect(queuedCalls).toBe(0);
      peer.exec('ROLLBACK'); peerHolding = false;
      expect((await queued).ok).toBe(true);
      expect(queuedCalls).toBe(1);
      expect(gate.runExclusiveSync(() => 'healthy')).toBe('healthy');
    } finally {
      if (peerHolding) peer.exec('ROLLBACK');
      await queued; await gate.close(); peer.close();
    }
  });

  it.each([
    [ 'COMMIT', false ], [ 'COMMIT', true ],
    [ 'ROLLBACK', false ], [ 'ROLLBACK', true ],
  ] as const)('poisons after %s failure; close failure=%s cannot falsely release an actual transaction', async (releaseSql, failClose) => {
    const runtime = getSqliteRuntime();
    const originalOpen = runtime.openDatabase.bind(runtime);
    const peer = originalOpen(databasePath);
    peer.pragma('busy_timeout = 0');
    let owned: SqliteDatabase | undefined;
    let closed = false;
    let injectRelease = false;
    let injectClose = failClose;
    const releaseError = new Error(`Root controlled ${releaseSql} failure`);
    const closeError = new Error('Root controlled same-connection close failure');
    vi.spyOn(runtime, 'openDatabase').mockImplementation((location, options) => {
      const actual = originalOpen(location, options);
      owned = actual;
      return {
        ...actual,
        exec: (sql: string): unknown => {
          if (injectRelease && sql.trim().toUpperCase() === releaseSql) throw releaseError;
          return actual.exec(sql);
        },
        close: (): void => {
          if (injectClose) throw closeError;
          actual.close(); closed = true;
        },
      };
    });
    const gate = new SqliteAuthorityExclusionGate(databasePath) as ImmediateGate;
    const entered = deferred();
    const release = deferred();
    const businessError = new Error('Root callback failed');
    let queuedCalls = 0;
    let newCalls = 0;
    const holder = observed(gate.runExclusive(async () => {
      entered.resolve(); await release.promise;
      if (releaseSql === 'ROLLBACK') throw businessError;
      return 'completed';
    }));
    let queued: ReturnType<typeof observed> | undefined;
    try {
      await entered.promise;
      queued = observed(gate.runExclusive(() => { queuedCalls += 1; }));
      injectRelease = true;
      release.resolve();
      const holderResult = await holder;
      expect(holderResult.ok).toBe(false);
      const queuedResult = await queued;
      expect(queuedResult.ok).toBe(false);
      if (!queuedResult.ok) {
        expect(queuedResult.error).toBeInstanceOf(AuthorityExclusionError);
        expect((queuedResult.error as Error).name).toBe('AuthorityExclusionPoisonedError');
      }
      expect(queuedCalls).toBe(0);
      const newResult = await observed(gate.runExclusive(() => { newCalls += 1; }));
      expect(newResult.ok).toBe(false);
      if (!newResult.ok) expect(newResult.error).toBeInstanceOf(AuthorityExclusionError);
      expect(() => gate.runExclusiveSync(() => { newCalls += 1; })).toThrow(AuthorityExclusionError);
      expect(newCalls).toBe(0);
      if (failClose) {
        await expect(gate.close()).rejects.toBeDefined();
        expect(closed).toBe(false);
        expect(() => peer.exec('BEGIN IMMEDIATE')).toThrow();
      } else {
        await expect(gate.close()).resolves.toBeUndefined();
        expect(closed).toBe(true);
        peer.exec('BEGIN IMMEDIATE'); peer.exec('ROLLBACK');
      }
    } finally {
      injectRelease = false; injectClose = false; release.resolve();
      await holder; await queued;
      await gate.close().catch(() => undefined);
      if (!closed) owned?.close();
      peer.close();
    }
  });

  it.each([ 'COMMIT', 'ROLLBACK' ] as const)('refuses new work after synchronous %s fails', async releaseSql => {
    const runtime = getSqliteRuntime();
    const originalOpen = runtime.openDatabase.bind(runtime);
    let owned: SqliteDatabase | undefined;
    let closed = false;
    let injectRelease = true;
    vi.spyOn(runtime, 'openDatabase').mockImplementation((location, options) => {
      const actual = originalOpen(location, options); owned = actual;
      return {
        ...actual,
        exec: (sql: string): unknown => {
          if (injectRelease && sql.trim().toUpperCase() === releaseSql) throw new Error(`Root ${releaseSql} failure`);
          return actual.exec(sql);
        },
        close: (): void => { actual.close(); closed = true; },
      };
    });
    const gate = new SqliteAuthorityExclusionGate(databasePath) as ImmediateGate;
    try {
      expect(typeof gate.runExclusiveSync).toBe('function');
      expect(() => gate.runExclusiveSync(() => {
        if (releaseSql === 'ROLLBACK') throw new Error('Root sync callback failure');
        return 42;
      })).toThrow();
      let calls = 0;
      expect(() => gate.runExclusiveSync(() => { calls += 1; })).toThrow(AuthorityExclusionError);
      expect((await observed(gate.runExclusive(() => { calls += 1; }))).ok).toBe(false);
      expect(calls).toBe(0);
    } finally {
      injectRelease = false;
      await gate.close().catch(() => undefined);
      if (!closed) owned?.close();
    }
  });

  it('refuses new sync callbacks after close while close awaits the actual active callback', async () => {
    const gate = new SqliteAuthorityExclusionGate(databasePath) as ImmediateGate;
    const entered = deferred();
    const release = deferred();
    const holder = observed(gate.runExclusive(async () => { entered.resolve(); await release.promise; }));
    let close: Promise<void> | undefined;
    let closeFinished = false;
    try {
      await entered.promise;
      close = gate.close();
      void close.then(() => { closeFinished = true; });
      let calls = 0;
      expect(() => gate.runExclusiveSync(() => { calls += 1; })).toThrow(AuthorityExclusionError);
      expect(calls).toBe(0);
      expect(closeFinished).toBe(false);
      release.resolve();
      expect((await holder).ok).toBe(true);
      await close;
      expect(closeFinished).toBe(true);
    } finally {
      release.resolve(); await holder; await close; await gate.close();
    }
  });
});
