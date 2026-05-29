import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
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

const DAY_MS = 24 * 60 * 60 * 1000;

describe('SolidFS sync journal', () => {
  let root: string;
  let workspaceRoot: string;
  let journalPath: string;
  let now: number;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'xpod-solidfs-journal-'));
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
