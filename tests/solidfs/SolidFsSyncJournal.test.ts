import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  JournaledSolidFsSyncer,
  LocalSolidFS,
  SqliteSolidFsSyncJournal,
  WorkspaceJournaledSolidFsSyncer,
  type SolidFsChange,
  type SolidFsManifest,
  type SolidFsSyncer,
} from '../../src/solidfs';

import { getSqliteRuntime } from '../../src/storage/SqliteRuntime';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('SolidFS sync journal', () => {
  let root: string;
  let workspaceRoot: string;
  let journalPath: string;
  let now: number;

  beforeEach(async () => {
    await mkdir(path.resolve('.test-data', 'solidfs-sync-journal'), { recursive: true });
    root = await mkdtemp(path.resolve('.test-data', 'solidfs-sync-journal', 'case-'));
    workspaceRoot = path.join(root, 'workspace');
    journalPath = path.join(root, 'control', 'sync-journal.sqlite');
    now = 1_000;
    await mkdir(workspaceRoot, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('replays pending file sync work after a failed commit and then becomes idempotent', async () => {
    await writeFile(path.join(workspaceRoot, 'data.ttl'), '<#me> <https://schema.org/name> "before" .\n', 'utf8');

    const failingSyncer: SolidFsSyncer = {
      shouldTrackPath: (relativePath): boolean => relativePath.endsWith('.ttl'),
      sync: vi.fn().mockRejectedValue(new Error('index offline')),
    };
    const journal = openJournal();
    const solidfs = new LocalSolidFS({
      syncer: new JournaledSolidFsSyncer({
        journal,
        syncer: failingSyncer,
      }),
    });
    const workspace = await solidfs.prepare({
      workspace: 'https://pod.example/alice/projects/demo/',
      sourcePath: workspaceRoot,
      projection: 'direct',
    });

    await writeFile(path.join(workspace.cwd, 'data.ttl'), '<#me> <https://schema.org/name> "after" .\n', 'utf8');
    await expect(workspace.commit()).rejects.toThrow('index offline');
    journal.close();

    const replayedChanges: SolidFsChange[] = [];
    const replayJournal = openJournal();
    const replaySyncer = new JournaledSolidFsSyncer({
      journal: replayJournal,
      syncer: {
        shouldTrackPath: (relativePath): boolean => relativePath.endsWith('.ttl'),
        async sync(change): Promise<void> {
          replayedChanges.push(change);
        },
      },
    });

    const firstReplay = await replaySyncer.replayPending();
    const secondReplay = await replaySyncer.replayPending();

    expect(firstReplay).toEqual({
      attempted: 1,
      completed: 1,
      failed: 0,
      reconcileRequired: 0,
    });
    expect(secondReplay).toEqual({
      attempted: 0,
      completed: 0,
      failed: 0,
      reconcileRequired: 0,
    });
    expect(replayedChanges).toEqual([
      expect.objectContaining({
        path: 'data.ttl',
        resource: 'https://pod.example/alice/projects/demo/data.ttl',
        sourcePath: path.join(workspaceRoot, 'data.ttl'),
        type: 'updated',
      }),
    ]);
    expect(replayJournal.listPending()).toEqual([]);
    expect(replayJournal.listOperations()).toHaveLength(1);
    expect(replayJournal.listOperations()[0].stage).toBe('done');
    replayJournal.close();
  });

  it('groups multi-file commit journal entries with the same transaction id', async () => {
    await writeFile(path.join(workspaceRoot, 'one.ttl'), '<#one> <https://schema.org/name> "One" .\n', 'utf8');
    await writeFile(path.join(workspaceRoot, 'two.ttl'), '<#two> <https://schema.org/name> "Two" .\n', 'utf8');

    const journal = openJournal();
    const solidfs = new LocalSolidFS({
      syncer: new JournaledSolidFsSyncer({
        journal,
        syncer: {
          shouldTrackPath: (relativePath): boolean => relativePath.endsWith('.ttl'),
          async sync(): Promise<void> {
            // Journal tx grouping is independent of the concrete sync target.
          },
        },
      }),
    });
    const workspace = await solidfs.prepare({
      workspace: 'https://pod.example/alice/projects/demo/',
      sourcePath: workspaceRoot,
      projection: 'direct',
    });

    await writeFile(path.join(workspace.cwd, 'one.ttl'), '<#one> <https://schema.org/name> "One updated" .\n', 'utf8');
    await writeFile(path.join(workspace.cwd, 'two.ttl'), '<#two> <https://schema.org/name> "Two updated" .\n', 'utf8');
    await workspace.commit();

    const operations = journal.listOperations()
      .filter((op) => op.change.path === 'one.ttl' || op.change.path === 'two.ttl');
    const txIds = new Set(operations.map((op) => op.txId));
    expect(operations).toHaveLength(2);
    expect([...txIds]).toHaveLength(1);
    expect([...txIds][0]).toMatch(/^solidfs_tx_/u);
    expect(operations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        change: expect.objectContaining({ path: 'one.ttl' }),
        stage: 'done',
      }),
      expect.objectContaining({
        change: expect.objectContaining({ path: 'two.ttl' }),
        stage: 'done',
      }),
    ]));
    journal.close();
  });

  it('does not checkpoint different bytes written while indexing was in progress', async () => {
    const file = path.join(workspaceRoot, 'data.ttl');
    await writeFile(file, '<#data> <urn:name> "before" .\n');
    const journal = openJournal();
    try {
      const operation = await journal.recordLocalCommitted(changeFor('data.ttl', 'updated'), manifestFor(workspaceRoot));
      await writeFile(file, '<#data> <urn:name> "concurrent change" .\n');
      await expect(journal.markDone(operation.id)).rejects.toThrow('source changed');
      expect(journal.getOperation(operation.id)?.stage).toBe('failed_retryable');
      const bootstrap = await journal.bootstrapWorkspace({
        workspace: manifestFor(workspaceRoot).workspace,
        cwd: workspaceRoot,
        shouldTrackPath: (value) => value.endsWith('.ttl'),
      });
      expect(bootstrap.skipped).toBe(0);
      expect(bootstrap.enqueued).toBe(1);
    } finally {
      journal.close();
    }
  });

  const directProjectionChange = (file: string): SolidFsChange => ({
    path: 'seed.txt',
    resource: 'https://pod.example/alice/projects/demo/seed.txt',
    source: 'pod-http',
    sourcePath: file,
    contentType: 'text/plain',
    projection: 'direct',
    type: 'created',
  });

  it('checkpoints a direct-projection sync whose own write only advanced the timestamp (same bytes)', async () => {
    const file = path.join(workspaceRoot, 'seed.txt');
    await writeFile(file, 'Acceptance workspace\n', 'utf8');
    const journal = openJournal();
    try {
      // A direct-projection Pod write PUTs the resource whose local file is the same
      // authority CSS serves, so the sync write itself advances the file version
      // (mtime) without changing the bytes. That must still checkpoint.
      const writingSyncer: SolidFsSyncer = {
        sync: async (change) => { await writeFile(change.sourcePath, 'Acceptance workspace\n', 'utf8'); },
      };
      const journaled = new JournaledSolidFsSyncer({ journal, syncer: writingSyncer });
      await journaled.sync(directProjectionChange(file), manifestFor(workspaceRoot));

      const [operation] = journal.listOperations(['done']);
      expect(operation?.change.path).toBe('seed.txt');
      expect(operation?.stage).toBe('done');
    } finally {
      journal.close();
    }
  });

  it('keeps the guard when a concurrent writer changed the authority bytes during the sync', async () => {
    const file = path.join(workspaceRoot, 'seed.txt');
    await writeFile(file, 'Acceptance workspace\n', 'utf8');
    const journal = openJournal();
    try {
      // A different writer replacing the content during an in-flight sync is not
      // this operation's result and must not be checkpointed as done.
      const concurrentSyncer: SolidFsSyncer = {
        sync: async (change) => { await writeFile(change.sourcePath, 'concurrent different bytes\n', 'utf8'); },
      };
      const journaled = new JournaledSolidFsSyncer({ journal, syncer: concurrentSyncer });
      await expect(journaled.sync(directProjectionChange(file), manifestFor(workspaceRoot)))
        .rejects.toThrow('source changed');

      expect(journal.listOperations(['done'])).toHaveLength(0);
      const [operation] = journal.listOperations(['failed_retryable']);
      expect(operation?.change.path).toBe('seed.txt');
    } finally {
      journal.close();
    }
  });

  it('supersedes only older failed authority work after a newer version is verified complete', async () => {
    const file = path.join(workspaceRoot, 'data.ttl');
    const journal = openJournal();
    try {
      await writeFile(file, '<#data> <urn:name> "before" .\n');
      const first = await journal.recordLocalCommitted(changeFor('data.ttl', 'updated'), manifestFor(workspaceRoot));
      await journal.markRetryableFailure(first.id, new Error('index temporarily unavailable'));
      await writeFile(file, '<#data> <urn:name> "after" .\n');
      const second = await journal.recordLocalCommitted(changeFor('data.ttl', 'updated'), manifestFor(workspaceRoot));
      await journal.markDone(second.id);
      expect(journal.getOperation(first.id)?.stage).toBe('failed_permanent');
      expect(journal.getOperation(second.id)?.stage).toBe('done');
      expect(journal.listPending()).toEqual([]);
      const third = await journal.recordLocalCommitted(changeFor('data.ttl', 'created'), manifestFor(workspaceRoot));
      await journal.markDone(second.id);
      expect(journal.getOperation(third.id)?.stage).toBe('local_committed');
    } finally {
      journal.close();
    }
  });

  it('orders same-millisecond operations by insertion rather than hash id', async () => {
    const journal = openJournal();
    try {
      const ids: string[] = [];
      for (let index = 0; index < 8; index += 1) {
        const name = `file-${index}.ttl`;
        await writeFile(path.join(workspaceRoot, name), '<#data> <urn:name> "body" .\n');
        ids.push((await journal.recordLocalCommitted(changeFor(name, 'updated'), manifestFor(workspaceRoot))).id);
      }
      expect(journal.listPending().map((op) => op.id)).toEqual(ids);
      expect(journal.listOperations().map((op) => op.id)).toEqual(ids);
    } finally {
      journal.close();
    }
  });

  it('skips superseded work from a replay snapshot even when newer work runs first', async () => {
    const file = path.join(workspaceRoot, 'data.ttl');
    const journal = openJournal();
    try {
      await writeFile(file, '<#data> <urn:name> "before" .\n');
      const old = await journal.recordLocalCommitted(changeFor('data.ttl', 'updated'), manifestFor(workspaceRoot));
      await writeFile(file, '<#data> <urn:name> "after" .\n');
      const latest = await journal.recordLocalCommitted(changeFor('data.ttl', 'updated'), manifestFor(workspaceRoot));
      vi.spyOn(journal, 'listPending').mockReturnValueOnce([latest, old]);
      const sync = vi.fn().mockResolvedValue(undefined);
      expect(await journal.replayPending({ sync })).toEqual({ attempted: 1, completed: 1, failed: 0, reconcileRequired: 0 });
      expect(sync).toHaveBeenCalledTimes(1);
      expect(journal.getOperation(old.id)?.stage).toBe('failed_permanent');
      expect(journal.getOperation(latest.id)?.stage).toBe('done');
      expect(journal.listOperations(['failed_retryable', 'reconcile_required'])).toEqual([]);
    } finally {
      journal.close();
    }
  });

  it('ignores late completion and failure callbacks for terminal operations', async () => {
    await writeFile(path.join(workspaceRoot, 'data.ttl'), '<#data> <urn:name> "body" .\n');
    const journal = openJournal();
    try {
      const done = await journal.recordLocalCommitted(changeFor('data.ttl', 'updated'), manifestFor(workspaceRoot));
      await journal.markDone(done.id);
      const failed = await journal.recordLocalCommitted(changeFor('data.ttl', 'created'), manifestFor(workspaceRoot));
      await journal.markFailedPermanent(failed.id, 'abandoned');
      for (const operation of [done, failed]) {
        const before = journal.getOperation(operation.id);
        await journal.markRetryableFailure(operation.id, 'late failure');
        await journal.markReconcileRequired(operation.id, 'late validation');
        await journal.markFailedPermanent(operation.id, 'late abandonment');
        await journal.markDone(operation.id);
        expect(journal.getOperation(operation.id)).toEqual(before);
      }
    } finally {
      journal.close();
    }
  });

  it('reuses a completed child-workspace receipt only for the same physical file and resource', async () => {
    const child = path.join(workspaceRoot, 'child');
    await mkdir(child);
    const file = path.join(child, 'data.ttl');
    await writeFile(file, '<#data> <urn:name> "body" .\n');
    const journal = openJournal();
    try {
      const resource = 'https://pod.example/child/data.ttl';
      const operation = await journal.recordLocalCommitted({
        path: 'data.ttl', resource, source: 'filesystem', sourcePath: file, type: 'updated', projection: 'direct',
      }, { workspace: 'https://pod.example/child/', cwd: child, projection: 'direct', entries: [] });
      await journal.markDone(operation.id);
      const input = { workspace: 'https://pod.example/', cwd: workspaceRoot, shouldTrackPath: (value: string) => value.endsWith('.ttl') };
      expect(await journal.bootstrapWorkspace(input)).toEqual({ scanned: 1, enqueued: 0, skipped: 1 });
      expect(await journal.bootstrapWorkspace({ ...input, resolveResource: async () => 'https://other.example/data.ttl' }))
        .toEqual({ scanned: 1, enqueued: 1, skipped: 0 });
    } finally {
      journal.close();
    }
  });

  it('migrates legacy checkpoints with resource bindings and replays those lacking retained proof', async () => {
    await writeFile(path.join(workspaceRoot, 'data.ttl'), '<#data> <urn:name> "body" .\n');
    const initial = openJournal();
    const manifest = manifestFor(workspaceRoot);
    const operation = await initial.recordLocalCommitted(changeFor('data.ttl', 'updated'), manifest);
    await initial.markDone(operation.id);
    initial.close();
    const database = getSqliteRuntime().openDatabase(journalPath);
    database.exec('ALTER TABLE sync_checkpoints DROP COLUMN resource');
    database.close();
    const migrated = openJournal();
    try {
      expect(await migrated.bootstrapWorkspace({ workspace: manifest.workspace, cwd: workspaceRoot }))
        .toEqual({ scanned: 1, enqueued: 0, skipped: 1 });
      expect(await migrated.bootstrapWorkspace({
        workspace: manifest.workspace, cwd: workspaceRoot, resolveResource: async () => 'https://other.example/data.ttl',
      })).toEqual({ scanned: 1, enqueued: 1, skipped: 0 });
    } finally {
      migrated.close();
    }
    const compacted = getSqliteRuntime().openDatabase(journalPath);
    compacted.exec('DELETE FROM sync_ops; ALTER TABLE sync_checkpoints DROP COLUMN resource');
    compacted.close();
    const withoutProof = openJournal();
    try {
      expect(await withoutProof.bootstrapWorkspace({ workspace: manifest.workspace, cwd: workspaceRoot }))
        .toEqual({ scanned: 1, enqueued: 1, skipped: 0 });
    } finally {
      withoutProof.close();
    }
  });

  it('persists and replays moved entries with previous path and shared transaction id', async () => {
    await mkdir(path.join(workspaceRoot, 'new'), { recursive: true });
    await writeFile(path.join(workspaceRoot, 'new', 'data.ttl'), '<#me> <https://schema.org/name> "Moved" .\n', 'utf8');

    const journal = openJournal();
    const change: SolidFsChange = {
      type: 'moved',
      previousPath: 'old/data.ttl',
      previousResource: 'https://pod.example/alice/projects/demo/old/data.ttl',
      path: 'new/data.ttl',
      resource: 'https://pod.example/alice/projects/demo/new/data.ttl',
      source: 'filesystem',
      sourcePath: path.join(workspaceRoot, 'new', 'data.ttl'),
      contentType: 'text/turtle',
      projection: 'direct',
      sourceVersion: 'etag-new',
    };
    const manifest: SolidFsManifest = {
      workspace: 'https://pod.example/alice/projects/demo/',
      cwd: workspaceRoot,
      projection: 'direct',
      entries: [],
    };

    await journal.recordLocalCommitted(change, manifest, 'solidfs_tx_move');

    const replayed: SolidFsChange[] = [];
    const result = await journal.replayPending({
      async sync(next): Promise<void> {
        replayed.push(next);
      },
    });

    expect(result).toEqual({ attempted: 1, completed: 1, failed: 0, reconcileRequired: 0 });
    expect(replayed).toEqual([
      expect.objectContaining({
        type: 'moved',
        previousPath: 'old/data.ttl',
        previousResource: 'https://pod.example/alice/projects/demo/old/data.ttl',
        path: 'new/data.ttl',
        resource: 'https://pod.example/alice/projects/demo/new/data.ttl',
      }),
    ]);
    expect(journal.listOperations()[0]).toMatchObject({
      txId: 'solidfs_tx_move',
      stage: 'done',
    });
    journal.close();
  });

  it('keeps moved entries with different previous paths as distinct operations', async () => {
    await mkdir(path.join(workspaceRoot, 'new'), { recursive: true });
    await writeFile(path.join(workspaceRoot, 'new', 'data.ttl'), '<#me> <https://schema.org/name> "Moved" .\n', 'utf8');

    const journal = openJournal();
    const manifest: SolidFsManifest = {
      workspace: 'https://pod.example/alice/projects/demo/',
      cwd: workspaceRoot,
      projection: 'direct',
      entries: [],
    };
    const change: SolidFsChange = {
      type: 'moved',
      previousPath: 'old-one/data.ttl',
      previousResource: 'https://pod.example/alice/projects/demo/old-one/data.ttl',
      path: 'new/data.ttl',
      resource: 'https://pod.example/alice/projects/demo/new/data.ttl',
      source: 'filesystem',
      sourcePath: path.join(workspaceRoot, 'new', 'data.ttl'),
      contentType: 'text/turtle',
      projection: 'direct',
      sourceVersion: 'etag-new',
    };

    await journal.recordLocalCommitted(change, manifest, 'solidfs_tx_move_one');
    await journal.recordLocalCommitted({
      ...change,
      previousPath: 'old-two/data.ttl',
      previousResource: 'https://pod.example/alice/projects/demo/old-two/data.ttl',
    }, manifest, 'solidfs_tx_move_two');

    expect(journal.listOperations()).toHaveLength(2);
    journal.close();
  });

  it('bootstraps existing workspace files into replayable journal work without duplicating checkpointed files', async () => {
    await mkdir(path.join(workspaceRoot, 'notes'), { recursive: true });
    await writeFile(path.join(workspaceRoot, 'data.ttl'), '<#me> <https://schema.org/name> "Alice" .\n', 'utf8');
    await writeFile(path.join(workspaceRoot, 'notes', 'ignore.txt'), 'not an RDF document\n', 'utf8');

    const journal = openJournal();
    const synced: SolidFsChange[] = [];
    const syncer = new JournaledSolidFsSyncer({
      journal,
      syncer: {
        shouldTrackPath: (relativePath): boolean => relativePath.endsWith('.ttl'),
        async sync(change): Promise<void> {
          synced.push(change);
        },
      },
    });

    const bootstrap = await syncer.bootstrapWorkspace({
      workspace: 'https://pod.example/alice/projects/demo/',
      cwd: workspaceRoot,
      projection: 'direct',
    });
    const replay = await syncer.replayPending();
    const secondBootstrap = await syncer.bootstrapWorkspace({
      workspace: 'https://pod.example/alice/projects/demo/',
      cwd: workspaceRoot,
      projection: 'direct',
    });

    expect(bootstrap).toEqual({
      scanned: 1,
      enqueued: 1,
      skipped: 0,
    });
    expect(replay.completed).toBe(1);
    expect(synced).toEqual([
      expect.objectContaining({
        path: 'data.ttl',
        resource: 'https://pod.example/alice/projects/demo/data.ttl',
        type: 'created',
      }),
    ]);
    expect(secondBootstrap).toEqual({
      scanned: 1,
      enqueued: 0,
      skipped: 1,
    });
    journal.close();
  });

  it('keeps pending and tombstone work while compacting checkpointed done entries', async () => {
    await writeFile(path.join(workspaceRoot, 'done.ttl'), '<#done> <https://schema.org/name> "Done" .\n', 'utf8');
    await writeFile(path.join(workspaceRoot, 'pending.ttl'), '<#pending> <https://schema.org/name> "Pending" .\n', 'utf8');
    await writeFile(path.join(workspaceRoot, 'retry.ttl'), '<#retry> <https://schema.org/name> "Retry" .\n', 'utf8');

    const journal = openJournal();
    const manifest = manifestFor(workspaceRoot);
    const done = await journal.recordLocalCommitted(changeFor('done.ttl', 'updated'), manifest);
    await journal.markDone(done.id);
    await journal.recordLocalCommitted(changeFor('pending.ttl', 'updated'), manifest);
    const retry = await journal.recordLocalCommitted(changeFor('retry.ttl', 'updated'), manifest);
    await journal.markRetryableFailure(retry.id, new Error('temporary failure'));
    const tombstone = await journal.recordLocalCommitted({
      ...changeFor('deleted.ttl', 'deleted'),
      sourceVersion: 'old-version',
    }, manifest);
    await journal.markDone(tombstone.id);

    now += 8 * DAY_MS;
    const compact = await journal.compact();
    const remaining = journal.listOperations();
    const remainingSummary = remaining.map((op) => ({
      path: op.change.path,
      stage: op.stage,
      type: op.change.type,
    }));

    expect(compact).toEqual({ deletedOps: 1 });
    expect(remainingSummary).toHaveLength(3);
    expect(remainingSummary).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: 'pending.ttl',
        stage: 'local_committed',
        type: 'updated',
      }),
      expect.objectContaining({
        path: 'retry.ttl',
        stage: 'failed_retryable',
        type: 'updated',
      }),
      expect.objectContaining({
        path: 'deleted.ttl',
        stage: 'done',
        type: 'deleted',
      }),
    ]));
    journal.close();
  });

  it('applies lifecycle retention for done, tombstone, and permanent failure entries', async () => {
    await writeFile(path.join(workspaceRoot, 'done.ttl'), '<#done> <https://schema.org/name> "Done" .\n', 'utf8');
    const journal = openJournal();
    const syncer = new JournaledSolidFsSyncer({
      journal,
      syncer: {
        async sync(): Promise<void> {
          // No-op syncer; this test exercises journal lifecycle rules directly.
        },
      },
    });
    const manifest = manifestFor(workspaceRoot);

    const done = await journal.recordLocalCommitted(changeFor('done.ttl', 'updated'), manifest);
    await journal.markDone(done.id);
    const tombstone = await journal.recordLocalCommitted({
      ...changeFor('deleted.ttl', 'deleted'),
      sourceVersion: 'old-version',
    }, manifest);
    await journal.markDone(tombstone.id);
    const permanent = await journal.recordLocalCommitted(changeFor('failed.ttl', 'updated'), manifest);
    await journal.markFailedPermanent(permanent.id, new Error('unsupported document'));

    now += 8 * DAY_MS;
    expect(await syncer.compact()).toEqual({ deletedOps: 1 });
    expect(journal.listOperations().map((op) => op.change.path)).toEqual(expect.arrayContaining([
      'deleted.ttl',
      'failed.ttl',
    ]));

    now += 23 * DAY_MS;
    expect(await syncer.compact()).toEqual({ deletedOps: 2 });
    expect(journal.listOperations()).toEqual([]);
    journal.close();
  });

  it('marks stale pending work for reconcile instead of replaying old file content', async () => {
    await writeFile(path.join(workspaceRoot, 'data.ttl'), '<#me> <https://schema.org/name> "one" .\n', 'utf8');
    const journal = openJournal();
    await journal.recordLocalCommitted(changeFor('data.ttl', 'updated'), manifestFor(workspaceRoot));
    await writeFile(path.join(workspaceRoot, 'data.ttl'), '<#me> <https://schema.org/name> "two" .\n', 'utf8');
    const sync = vi.fn().mockResolvedValue(undefined);

    const replay = await journal.replayPending({
      async sync(...args): Promise<void> {
        sync(...args);
      },
    });

    expect(replay).toEqual({
      attempted: 1,
      completed: 0,
      failed: 0,
      reconcileRequired: 1,
    });
    expect(sync).not.toHaveBeenCalled();
    expect(journal.listOperations()[0]).toMatchObject({
      stage: 'reconcile_required',
      lastError: 'SolidFS journal source changed before replay: data.ttl',
    });
    journal.close();
  });

  it('replays pending workspace journal work from LocalSolidFS prepare after restart', async () => {
    await writeFile(path.join(workspaceRoot, 'data.ttl'), '<#me> <https://schema.org/name> "Alice" .\n', 'utf8');
    const journalRoot = path.join(root, 'control');
    const failingSyncer = new WorkspaceJournaledSolidFsSyncer({
      journalRoot,
      syncer: {
        shouldTrackPath: (relativePath): boolean => relativePath.endsWith('.ttl'),
        sync: vi.fn().mockRejectedValue(new Error('remote unavailable')),
      },
    });

    const firstSolidfs = new LocalSolidFS({ syncer: failingSyncer });
    const firstWorkspace = await firstSolidfs.prepare({
      workspace: 'https://pod.example/alice/projects/demo/',
      sourcePath: workspaceRoot,
      projection: 'direct',
    });
    expect(firstWorkspace.cwd).toBe(workspaceRoot);
    failingSyncer.close();

    const replayed: SolidFsChange[] = [];
    const recoveringSyncer = new WorkspaceJournaledSolidFsSyncer({
      journalRoot,
      syncer: {
        shouldTrackPath: (relativePath): boolean => relativePath.endsWith('.ttl'),
        async sync(change): Promise<void> {
          replayed.push(change);
        },
      },
    });
    const secondSolidfs = new LocalSolidFS({ syncer: recoveringSyncer });

    await secondSolidfs.prepare({
      workspace: 'https://pod.example/alice/projects/demo/',
      sourcePath: workspaceRoot,
      projection: 'direct',
    });
    await secondSolidfs.prepare({
      workspace: 'https://pod.example/alice/projects/demo/',
      sourcePath: workspaceRoot,
      projection: 'direct',
    });

    expect(replayed).toEqual([
      expect.objectContaining({
        path: 'data.ttl',
        resource: 'https://pod.example/alice/projects/demo/data.ttl',
        type: 'created',
      }),
    ]);
    recoveringSyncer.close();
  });

  function openJournal(): SqliteSolidFsSyncJournal {
    return new SqliteSolidFsSyncJournal({
      path: journalPath,
      now: () => now,
    });
  }

  function manifestFor(cwd: string): SolidFsManifest {
    return {
      workspace: 'https://pod.example/alice/projects/demo/',
      cwd,
      projection: 'direct',
      entries: [],
    };
  }

  function changeFor(relativePath: string, type: SolidFsChange['type']): SolidFsChange {
    return {
      path: relativePath,
      resource: `https://pod.example/alice/projects/demo/${relativePath}`,
      source: 'pod-http',
      sourcePath: path.join(workspaceRoot, relativePath),
      contentType: 'text/turtle',
      projection: 'direct',
      type,
    };
  }
});
