import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  AuthorityExclusionClosedError,
  AuthorityExclusionTimeoutError,
  SqliteAuthorityExclusionGate,
  authorityCoordinationDatabasePath,
} from '../../../src/storage/AuthorityExclusionGate';
import { SqliteSolidFsSyncJournal } from '../../../src/solidfs/SolidFsSyncJournal';
import { AuthorityFreshnessService } from '../../../src/storage/AuthorityFreshnessService';
import type { SolidFsChange, SolidFsManifest } from '../../../src/solidfs/types';

const workspace: SolidFsManifest = { workspace: 'http://example.org/', cwd: '/tmp', projection: 'direct', entries: [] };
const change = (p: string): SolidFsChange => ({
  path: p.replace(/^\//u, ''), resource: `http://example.org${p}`, sourcePath: `/tmp${p}`, source: 'filesystem', projection: 'direct', type: 'updated',
});

describe('authority exclusion gate (product surface)', () => {
  let root: string;
  let db: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'xpod-authority-exclusion-'));
    db = path.join(root, 'coordination.sqlite');
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('refuses a queued request by submission-time deadline even when the timer has not fired', async () => {
    const gate = new SqliteAuthorityExclusionGate(db);
    let release!: () => void;
    const holder = gate.runExclusive(() => new Promise<void>((resolve) => {
      release = resolve;
    }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    let ran = false;
    const started = Date.now();
    // Block the event loop past the waiter deadline so its setTimeout cannot dispatch.
    const waiter = gate.runExclusive(() => {
      ran = true;
    }, { timeoutMs: 10 });
    while (Date.now() - started < 40) { /* stall */ }
    release();
    await holder;
    await expect(waiter).rejects.toBeInstanceOf(AuthorityExclusionTimeoutError);
    expect(ran).toBe(false);
    await gate.close();
  });

  it('rejects with the original thrown value even when it is undefined', async () => {
    const gate = new SqliteAuthorityExclusionGate(db);
    await expect(gate.runExclusive(() => {
      throw undefined;
    })).rejects.toBeUndefined();
    // connection remains usable
    await expect(gate.runExclusive(() => 'ok')).resolves.toBe('ok');
    await gate.close();
  });

  it('rejects a second queue entry after close and awaits the active callback', async () => {
    const gate = new SqliteAuthorityExclusionGate(db);
    let finished = false;
    const holder = gate.runExclusive(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      finished = true;
    });
    const first = gate.close();
    const second = gate.close();
    await expect(gate.runExclusive(() => 'nope')).rejects.toBeInstanceOf(AuthorityExclusionClosedError);
    await Promise.all([holder, first, second]);
    expect(finished).toBe(true);
  });

  it('derives the coordination database path outside copied Pod directories', () => {
    const domain = authorityCoordinationDatabasePath('/srv/pod/data/');
    expect(domain).toMatch(/^\/srv\/pod\/\.xpod-control\/authority-coordination\/[^/]+\/exclusion\.sqlite$/u);
    expect(domain.startsWith('/srv/pod/data/')).toBe(false);
    expect(authorityCoordinationDatabasePath('/srv/pod/data')).toBe(domain);
    expect(authorityCoordinationDatabasePath('/srv/pod/./data/')).toBe(domain);
    expect(authorityCoordinationDatabasePath('/srv/pod/other')).not.toBe(domain);
  });

  it('coordinates two instances over the same physical file', async () => {
    const a = new SqliteAuthorityExclusionGate(db);
    const b = new SqliteAuthorityExclusionGate(db);
    let inCritical = 0;
    let overlap = false;
    const work = async (): Promise<void> => {
      inCritical += 1;
      if (inCritical > 1) overlap = true;
      await new Promise((resolve) => setTimeout(resolve, 10));
      inCritical -= 1;
    };
    await Promise.all([a.runExclusive(work), b.runExclusive(work)]);
    expect(overlap).toBe(false);
    await a.close();
    await b.close();
  });
});

describe('authority pending freshness tokens', () => {
  let root: string;
  let journal: SqliteSolidFsSyncJournal;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'xpod-authority-pending-'));
    journal = new SqliteSolidFsSyncJournal({ path: path.join(root, 'journal.sqlite') });
  });
  afterEach(async () => {
    journal.close();
    await rm(root, { recursive: true, force: true });
  });

  it('records pending before a write and clears only the exact token', () => {
    const op = journal.recordAuthorityPending(change('/a.ttl'), workspace, 'hash-old');
    expect(journal.getAuthorityPending(op.id)).toBeDefined();
    expect(journal.listAuthorityPending('a.ttl')).toHaveLength(1);

    const freshness = new AuthorityFreshnessService(journal);
    expect(freshness.hasPending('a.ttl')).toBe(true);

    journal.attachAuthorityPendingHash(op.id, 'hash-new');
    expect(journal.clearAuthorityPending('pending_does_not_exist')).toBe(false);
    expect(journal.clearAuthorityPending(op.id)).toBe(true);
    expect(freshness.hasPending('a.ttl')).toBe(false);
  });

  it('does not clear a newer pending token when an older token is cleared', () => {
    const older = journal.recordAuthorityPending(change('/a.ttl'), workspace, 'hash-old');
    const newer = journal.recordAuthorityPending(change('/a.ttl'), workspace, 'hash-newer');
    expect(older.id).not.toBe(newer.id);
    // A stale recovery attempt naming the older token must not clear the newer one.
    journal.clearAuthorityPending(older.id);
    expect(journal.listAuthorityPending('a.ttl').map((op) => op.id)).toEqual([newer.id]);
  });
});
