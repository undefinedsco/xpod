import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getSqliteRuntime, type SqliteDatabase } from '../../../src/storage/SqliteRuntime';
import {
  InMemoryMatrixEventJournal,
  SqlMatrixEventJournal,
  validateReconcileSourceUri,
  type MatrixEventJournal,
  type MatrixReferencePage,
} from '../../../src/api/matrix/MatrixEventJournal';

const SCOPE = 'https://pod.example/alice/';
const SOURCE = 'https://source.example/rooms/';
/** A source row is named by an absolute full source IRI (a bundle resource), not an event id. */
const sourceRow = (name: string): string => `${SOURCE}room-a/messages.ttl#${name}`;

const opened: SqliteDatabase[] = [];
const directories: string[] = [];

function openDatabase(filename: string): SqliteDatabase {
  const runtime = getSqliteRuntime();
  const database = runtime.openDatabase(filename);
  // The write lock is the cross-connection serialization point; wait instead of failing busy.
  database.pragma('busy_timeout = 10000');
  opened.push(database);
  return database;
}

function openJournal(filename: string): { journal: SqlMatrixEventJournal; database: SqliteDatabase } {
  const database = openDatabase(filename);
  return { journal: new SqlMatrixEventJournal(getSqliteRuntime().createDrizzleDatabase(database)), database };
}

function tempFile(): string {
  const directory = mkdtempSync(path.join(process.cwd(), '.test-data', 'journal-checkpoint-'));
  directories.push(directory);
  return path.join(directory, 'journal.sqlite');
}

afterEach(() => {
  for (const database of opened.splice(0)) {
    try {
      database.close();
    } catch {
      // A second connection may already have closed it; persistence is what the test asserts.
    }
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function reference(roomId: string, eventId: string, createdAt: number, messageIri?: string) {
  return { roomId, eventId, createdAt, ...(messageIri === undefined ? {} : { messageIri }) };
}

/** A page that advances the cursor to the one row it carries, without completing a cycle. */
function pageAt(
  base: { sourceUri: string; epoch: string; scanGeneration: number; revision: number },
  eventId: string,
  createdAt: number,
  messageIri?: string,
): MatrixReferencePage {
  return {
    sourceUri: base.sourceUri,
    epoch: base.epoch,
    scanGeneration: base.scanGeneration,
    revision: base.revision,
    references: [ reference('!r:host', eventId, createdAt, messageIri) ],
    next: { roomId: '!r:host', last: { createdAt, sourceIri: sourceRow(eventId) } },
    complete: false,
  };
}

describe.each([
  [ 'memory', (): MatrixEventJournal => new InMemoryMatrixEventJournal() ],
  [ 'SQLite', (): MatrixEventJournal => openJournal(tempFile()).journal ],
] as const)('%s reconcile checkpoints', (_name, create) => {
  it('publishes a page and advances the checkpoint, then rejects a lost CAS', async () => {
    const journal = create();
    const start = await journal.beginReconcileScan(SCOPE, { sourceUri: SOURCE, view: 'v1' });
    expect(start.scanGeneration).toBe(1);
    expect(start.revision).toBe(0);
    expect(start.view).toBe('v1');

    const first = await journal.publishReferencePage(SCOPE, pageAt(start, '$a', 100, `${SCOPE}a.ttl#a`));
    expect(first.advanced).toBe(true);
    expect(first.checkpoint.revision).toBe(1);
    expect(first.checkpoint.roomCursor).toBe('!r:host');
    expect(first.checkpoint.lastCreatedAt).toBe(100);
    expect(first.checkpoint.lastSourceIri).toBe(sourceRow('$a'));
    expect(first.references[0]).toMatchObject({ eventId: '$a', messageIri: `${SCOPE}a.ttl#a`, createdAt: 100 });

    // The base revision is stale after the advance: nothing is published and the epoch is unchanged.
    const stale = await journal.publishReferencePage(SCOPE, pageAt(start, '$b', 200));
    expect(stale.advanced).toBe(false);
    expect(stale.references).toEqual([]);
    expect(stale.checkpoint.revision).toBe(1);
    expect((await journal.listReferences(SCOPE, { limit: 10 })).map(entry => entry.eventId)).toEqual([ '$a' ]);

    // Re-registering an existing event inside a later page keeps the first immutable reference.
    const next = await journal.publishReferencePage(SCOPE, {
      ...pageAt(first.checkpoint, '$a', 999, `${SCOPE}bogus.ttl#a`),
      references: [ reference('!r:host', '$a', 999, `${SCOPE}bogus.ttl#a`), reference('!r:host', '$b', 50) ],
      next: { roomId: '!r:host', last: { createdAt: 50, sourceIri: sourceRow('$b') } },
    });
    expect(next.advanced).toBe(true);
    expect(next.checkpoint.revision).toBe(2);
    const stored = await journal.listReferences(SCOPE, { limit: 10 });
    expect(stored.find(entry => entry.eventId === '$a')).toMatchObject({
      messageIri: `${SCOPE}a.ttl#a`,
      createdAt: 100,
      sequence: first.references[0].sequence,
    });
  });

  it('rotates to a fresh generation from the beginning when a cycle completes', async () => {
    const journal = create();
    const start = await journal.beginReconcileScan(SCOPE, { sourceUri: SOURCE });
    const published = await journal.publishReferencePage(SCOPE, pageAt(start, '$a', 100));
    const completed = await journal.publishReferencePage(SCOPE, {
      sourceUri: SOURCE,
      epoch: published.checkpoint.epoch,
      scanGeneration: published.checkpoint.scanGeneration,
      revision: published.checkpoint.revision,
      references: [],
      complete: true,
    });
    expect(completed.advanced).toBe(true);
    expect(completed.checkpoint.scanGeneration).toBe(2);
    // A completed pass is not a permanent watermark: the next cycle starts with no cursor.
    expect(completed.checkpoint.lastCreatedAt).toBeUndefined();
    expect(completed.checkpoint.lastSourceIri).toBeUndefined();
    expect(completed.checkpoint.roomCursor).toBeUndefined();
    expect(completed.checkpoint.lastCompletedAt).toBeTypeOf('number');
  });

  it('rejects a stale epoch after an index loss and publishes nothing', async () => {
    const journal = create();
    const start = await journal.beginReconcileScan(SCOPE, { sourceUri: SOURCE });
    await journal.bumpEpoch(SCOPE);
    await expect(journal.beginReconcileScan(SCOPE, { sourceUri: SOURCE, epoch: start.epoch }))
      .rejects.toThrow(/stale/i);
    const result = await journal.publishReferencePage(SCOPE, pageAt(start, '$a', 100));
    expect(result.advanced).toBe(false);
    expect(result.references).toEqual([]);
    expect(await journal.listReferences(SCOPE, { limit: 10 })).toEqual([]);
  });

  it('rejects a stale epoch that changes between reading it and taking the lock', async () => {
    // A subclass whose publish bumps the epoch in the window between the pre-lock epoch read and the
    // delegating publish, reproducing the reported gap deterministically for the memory carrier.
    class RacyJournal extends InMemoryMatrixEventJournal {
      public override async publishReferencePage(
        scope: string,
        page: Parameters<InMemoryMatrixEventJournal['publishReferencePage']>[1],
      ): Promise<Awaited<ReturnType<InMemoryMatrixEventJournal['publishReferencePage']>>> {
        await this.getEpoch(scope);
        await this.bumpEpoch(scope);
        return await super.publishReferencePage(scope, page);
      }
    }
    const journal = new RacyJournal();
    const start = await journal.beginReconcileScan(SCOPE, { sourceUri: SOURCE });
    const result = await journal.publishReferencePage(SCOPE, pageAt(start, '$a', 100));
    expect(result.advanced).toBe(false);
    expect(result.references).toEqual([]);
    expect(await journal.listReferences(SCOPE, { limit: 10 })).toEqual([]);
  });

  it('validates the source boundary', async () => {
    expect(() => validateReconcileSourceUri('https://user:pass@source.example/x')).toThrow();
    expect(() => validateReconcileSourceUri('https://source.example/x?q=1')).toThrow();
    expect(() => validateReconcileSourceUri('https://source.example/x#frag')).toThrow();
    expect(() => validateReconcileSourceUri('/relative')).toThrow();
    const journal = create();
    await expect(journal.beginReconcileScan(SCOPE, { sourceUri: 'https://source.example/x?q=1' }))
      .rejects.toThrow();
  });

  it('rejects an oversized reference page instead of truncating it', async () => {
    const journal = create();
    const start = await journal.beginReconcileScan(SCOPE, { sourceUri: SOURCE });
    const references = Array.from({ length: 4097 }, (_, index) => reference('!r:host', `$${index}`, 100));
    await expect(journal.publishReferencePage(SCOPE, {
      sourceUri: SOURCE,
      epoch: start.epoch,
      scanGeneration: start.scanGeneration,
      revision: start.revision,
      references,
      complete: false,
    })).rejects.toThrow(/cap/);
    const after = await journal.getReconcileCheckpoint(SCOPE, SOURCE);
    expect(after).toMatchObject({ revision: 0, scanGeneration: 1 });
    expect(await journal.listReferences(SCOPE, { limit: 10 })).toEqual([]);
  });

  it('rejects an unpaired or non-source cursor before any mutation', async () => {
    const journal = create();
    const start = await journal.beginReconcileScan(SCOPE, { sourceUri: SOURCE });
    const withCursor = (last: Record<string, unknown>): MatrixReferencePage => ({
      sourceUri: SOURCE,
      epoch: start.epoch,
      scanGeneration: start.scanGeneration,
      revision: start.revision,
      references: [ reference('!r:host', '$a', 100) ],
      next: { roomId: '!r:host', last: last as never },
      complete: false,
    });
    // A bare event id is not a source identity.
    await expect(journal.publishReferencePage(SCOPE, withCursor({ createdAt: 100, sourceIri: '$a' })))
      .rejects.toThrow(/absolute URI/i);
    // A non-finite time is rejected even with a syntactically valid source IRI.
    await expect(journal.publishReferencePage(SCOPE, withCursor({ createdAt: Number.NaN, sourceIri: sourceRow('$a') })))
      .rejects.toThrow(/finite/i);
    // A source IRI carrying a query is not a stable source row identity.
    await expect(journal.publishReferencePage(SCOPE, withCursor({ createdAt: 100, sourceIri: `${SOURCE}room-a?per-page=1#a` })))
      .rejects.toThrow(/query/i);
    const after = await journal.getReconcileCheckpoint(SCOPE, SOURCE);
    expect(after).toMatchObject({ revision: 0, scanGeneration: 1 });
    expect(await journal.listReferences(SCOPE, { limit: 10 })).toEqual([]);
  });

  it('rejects an incomplete page with no resumption position, leaving refs/cursor/revision intact', async () => {
    const journal = create();
    const start = await journal.beginReconcileScan(SCOPE, { sourceUri: SOURCE });
    // Establish an accepted first page so there is a cursor and a revision to preserve.
    const first = await journal.publishReferencePage(SCOPE, pageAt(start, '$a', 100));
    expect(first.advanced).toBe(true);
    const before = await journal.getReconcileCheckpoint(SCOPE, SOURCE);

    // Either a completed page may omit the cursor, or an incomplete page must declare a real
    // boundary; an incomplete page with no cursor at all is rejected.
    await expect(journal.publishReferencePage(SCOPE, {
      sourceUri: SOURCE, epoch: before!.epoch, scanGeneration: before!.scanGeneration,
      revision: before!.revision, references: [ reference('!r:host', '$b', 200) ], complete: false,
    })).rejects.toThrow(/boundary|paired source cursor/i);
    // `next: {}` is an empty boundary and is likewise rejected.
    await expect(journal.publishReferencePage(SCOPE, {
      sourceUri: SOURCE, epoch: before!.epoch, scanGeneration: before!.scanGeneration,
      revision: before!.revision, references: [ reference('!r:host', '$c', 300) ], next: {}, complete: false,
    })).rejects.toThrow(/boundary|paired source cursor/i);
    // `last` present but with only one half of the pair is rejected.
    await expect(journal.publishReferencePage(SCOPE, {
      sourceUri: SOURCE, epoch: before!.epoch, scanGeneration: before!.scanGeneration,
      revision: before!.revision, references: [ reference('!r:host', '$d', 400) ],
      next: { last: { createdAt: 400 } as never }, complete: false,
    })).rejects.toThrow(/source IRI|paired source cursor|boundary/i);

    const after = await journal.getReconcileCheckpoint(SCOPE, SOURCE);
    expect(after).toMatchObject({
      revision: before!.revision, scanGeneration: before!.scanGeneration,
      lastCreatedAt: before!.lastCreatedAt, lastSourceIri: before!.lastSourceIri,
    });
    expect((await journal.listReferences(SCOPE, { limit: 10 })).map(entry => entry.eventId)).toEqual([ '$a' ]);
  });

  it('accepts an incomplete page whose only resumption position is a declared room boundary', async () => {
    const journal = create();
    const start = await journal.beginReconcileScan(SCOPE, { sourceUri: SOURCE });
    const accepted = await journal.publishReferencePage(SCOPE, {
      sourceUri: SOURCE, epoch: start.epoch, scanGeneration: start.scanGeneration, revision: start.revision,
      references: [ reference('!r:host', '$a', 100) ], next: { roomId: '!r:host' }, complete: false,
    });
    expect(accepted.advanced).toBe(true);
    const after = await journal.getReconcileCheckpoint(SCOPE, SOURCE);
    expect(after).toMatchObject({ revision: 1, roomCursor: '!r:host' });
    // A declared boundary with no keyset does not fabricate one.
    expect(after?.lastSourceIri).toBeUndefined();
    expect(after?.lastCreatedAt).toBeUndefined();
  });

  it('binds a cycle view only on the first page and keeps it immutable', async () => {
    const journal = create();
    const start = await journal.beginReconcileScan(SCOPE, { sourceUri: SOURCE });
    const view = JSON.stringify({ version: 1, upper: null, observation: 'token-1' });
    const first = await journal.publishReferencePage(SCOPE, {
      ...pageAt(start, '$a', 100), view,
    });
    expect(first.advanced).toBe(true);
    expect(first.checkpoint.view).toBe(view);

    // A partial advance preserves the bound view.
    const second = await journal.publishReferencePage(SCOPE, {
      ...pageAt(first.checkpoint, '$b', 200),
    });
    expect(second.checkpoint.view).toBe(view);

    // A later page may not rebind a different view.
    const conflict = await journal.publishReferencePage(SCOPE, {
      ...pageAt(second.checkpoint, '$c', 300),
      view: JSON.stringify({ version: 1, upper: null, observation: 'token-2' }),
    });
    expect(conflict.advanced).toBe(false);
    expect(conflict.references).toEqual([]);
    expect((await journal.getReconcileCheckpoint(SCOPE, SOURCE))?.view).toBe(view);

    // Completing the cycle rotates the generation and clears the view.
    const completed = await journal.publishReferencePage(SCOPE, {
      sourceUri: SOURCE, epoch: second.checkpoint.epoch, scanGeneration: second.checkpoint.scanGeneration,
      revision: second.checkpoint.revision, references: [], complete: true,
    });
    expect(completed.advanced).toBe(true);
    expect(completed.checkpoint.view).toBeUndefined();
  });

  it('lets exactly one of two concurrent page bindings win the view CAS', async () => {
    const journal = create();
    const start = await journal.beginReconcileScan(SCOPE, { sourceUri: SOURCE });
    const pageWith = (view: string) => ({
      ...pageAt(start, '$a', 100), view,
    });
    const viewA = JSON.stringify({ version: 1, upper: null, observation: 'a' });
    const viewB = JSON.stringify({ version: 1, upper: null, observation: 'b' });
    const [ resultA, resultB ] = await Promise.all([
      journal.publishReferencePage(SCOPE, pageWith(viewA)),
      journal.publishReferencePage(SCOPE, pageWith(viewB)),
    ]);
    expect([ resultA.advanced, resultB.advanced ].filter(Boolean)).toHaveLength(1);
    const final = await journal.getReconcileCheckpoint(SCOPE, SOURCE);
    expect([ viewA, viewB ]).toContain(final?.view);
  });

  it('lets exactly one of two concurrent consumers win the same CAS', async () => {
    const journal = create();
    const start = await journal.beginReconcileScan(SCOPE, { sourceUri: SOURCE });
    const [ resultA, resultB ] = await Promise.all([
      journal.publishReferencePage(SCOPE, pageAt(start, '$a', 100)),
      journal.publishReferencePage(SCOPE, pageAt(start, '$b', 100)),
    ]);
    expect([ resultA.advanced, resultB.advanced ].filter(Boolean)).toHaveLength(1);
    // The loser publishes nothing beyond the winner's single reference.
    const stored = (await journal.listReferences(SCOPE, { limit: 10 })).map(entry => entry.eventId);
    expect(stored).toHaveLength(1);
    expect([ '$a', '$b' ]).toContain(stored[0]);
    const final = await journal.getReconcileCheckpoint(SCOPE, SOURCE);
    expect(final?.revision).toBe(1);
  });
});

describe('SQLite durable checkpoints', () => {
  it('reopens a persisted checkpoint on a fresh connection', async () => {
    const filename = tempFile();
    const first = openJournal(filename).journal;
    const start = await first.beginReconcileScan(SCOPE, { sourceUri: SOURCE });
    const published = await first.publishReferencePage(SCOPE, pageAt(start, '$a', 100, `${SCOPE}a.ttl#a`));
    expect(published.advanced).toBe(true);

    // A separate connection over the same file sees the committed checkpoint, proving durability.
    const second = openJournal(filename).journal;
    const reopened = await second.getReconcileCheckpoint(SCOPE, SOURCE);
    expect(reopened).toMatchObject({
      revision: published.checkpoint.revision,
      scanGeneration: published.checkpoint.scanGeneration,
      lastCreatedAt: 100,
      lastSourceIri: sourceRow('$a'),
    });
    expect((await second.listReferences(SCOPE, { limit: 10 })).map(entry => entry.eventId)).toEqual([ '$a' ]);
  });

  it('lets exactly one of two independently connected consumers win the same CAS', async () => {
    const filename = tempFile();
    const consumerA = openJournal(filename).journal;
    const consumerB = openJournal(filename).journal;
    const start = await consumerA.beginReconcileScan(SCOPE, { sourceUri: SOURCE });
    const seen = await consumerB.getReconcileCheckpoint(SCOPE, SOURCE);
    expect(seen?.revision).toBe(0);

    const [ resultA, resultB ] = await Promise.all([
      consumerA.publishReferencePage(SCOPE, pageAt(start, '$a', 100)),
      consumerB.publishReferencePage(SCOPE, pageAt(start, '$b', 100)),
    ]);
    expect([ resultA.advanced, resultB.advanced ].filter(Boolean)).toHaveLength(1);
    const final = await consumerA.getReconcileCheckpoint(SCOPE, SOURCE);
    expect(final?.revision).toBe(1);
  });

  it('rejects a real SQLite stale epoch changed on a second connection before the lock', async () => {
    const filename = tempFile();
    const first = openJournal(filename);
    const start = await first.journal.beginReconcileScan(SCOPE, { sourceUri: SOURCE });
    // A second, independent connection bumps the epoch. This commits before the first connection
    // acquires its write lock, exactly the reported boundary the old pre-lock epoch read missed.
    const second = openJournal(filename);
    await second.journal.bumpEpoch(SCOPE);
    expect(await first.journal.getEpoch(SCOPE)).not.toBe(start.epoch);

    const result = await first.journal.publishReferencePage(SCOPE, pageAt(start, '$a', 100));
    expect(result.advanced).toBe(false);
    expect(result.references).toEqual([]);
    expect(await first.journal.listReferences(SCOPE, { limit: 10 })).toEqual([]);
    // The stale page must not move the (now-invisible) checkpoint either.
    const after = await first.journal.getReconcileCheckpoint(SCOPE, SOURCE);
    expect(after).toBeUndefined();
  });

  it('rejects a real SQLite stale epoch that commits while the write lock is held', async () => {
    const filename = tempFile();
    const first = openJournal(filename);
    const start = await first.journal.beginReconcileScan(SCOPE, { sourceUri: SOURCE });

    // Hook the *first* connection's synchronous SQLite handle. On the very first `BEGIN IMMEDIATE`,
    // bump the epoch on a second connection *before* the first transaction begins, so the bump
    // commits in the exact window between the caller's epoch read and the lock acquisition. The hook
    // is test-only: it wraps the public SqliteDatabase `run`, never product internals.
    const handle = (first.journal as unknown as { db: { run: (q: unknown) => unknown } }).db;
    const originalRun = handle.run.bind(handle);
    let bumped = false;
    handle.run = (query: unknown): unknown => {
      // The first `run` inside publishReferencePageSqlite is the BEGIN IMMEDIATE; a second connection
      // commits a bump just before it, so the lock is acquired against a stale pre-read snapshot.
      if (!bumped) {
        bumped = true;
        const runtime = getSqliteRuntime();
        const raw = runtime.openDatabase(filename);
        opened.push(raw);
        raw.pragma('busy_timeout = 10000');
        raw.exec(`INSERT INTO xpod_matrix_journal_epoch (scope, epoch) VALUES ('${SCOPE}', 'bumped-epoch')
          ON CONFLICT (scope) DO UPDATE SET epoch = 'bumped-epoch'`);
        raw.close();
      }
      return originalRun(query);
    };

    const result = await first.journal.publishReferencePage(SCOPE, pageAt(start, '$a', 100));
    expect(bumped).toBe(true);
    expect(result.advanced).toBe(false);
    expect(result.references).toEqual([]);
    expect(await first.journal.listReferences(SCOPE, { limit: 10 })).toEqual([]);
    expect(await first.journal.getReconcileCheckpoint(SCOPE, SOURCE)).toBeUndefined();
  });

  it('rejects a beginReconcileScan carrying a stale epoch after a second connection bumps', async () => {
    const filename = tempFile();
    const first = openJournal(filename);
    const start = await first.journal.beginReconcileScan(SCOPE, { sourceUri: SOURCE });
    const second = openJournal(filename);
    await second.journal.bumpEpoch(SCOPE);
    // The caller's explicit resync token no longer matches the live epoch: begin must refuse it.
    await expect(first.journal.beginReconcileScan(SCOPE, { sourceUri: SOURCE, epoch: start.epoch }))
      .rejects.toThrow(/stale/i);
    // Omitting the token begins a fresh cycle under the new epoch instead of reusing the old one.
    const restarted = await first.journal.beginReconcileScan(SCOPE, { sourceUri: SOURCE });
    expect(restarted.epoch).not.toBe(start.epoch);
  });

  it('rolls back the whole page and leaves the checkpoint unchanged when a trigger aborts', async () => {
    const filename = tempFile();
    const { journal, database } = openJournal(filename);
    const start = await journal.beginReconcileScan(SCOPE, { sourceUri: SOURCE });
    database.exec(`
      CREATE TRIGGER abort_boom BEFORE INSERT ON xpod_matrix_event_refs
      WHEN NEW.event_id = '$boom'
      BEGIN SELECT RAISE(ABORT, 'boom'); END
    `);

    await expect(journal.publishReferencePage(SCOPE, {
      sourceUri: SOURCE,
      epoch: start.epoch,
      scanGeneration: start.scanGeneration,
      revision: start.revision,
      references: [ reference('!r:host', '$ok', 100), reference('!r:host', '$boom', 200) ],
      next: { roomId: '!r:host', last: { createdAt: 200, sourceIri: sourceRow('$boom') } },
      complete: false,
    })).rejects.toThrow();

    // The reference that was written before the abort must not survive, and no cursor advanced.
    const after = await journal.getReconcileCheckpoint(SCOPE, SOURCE);
    expect(after).toMatchObject({ revision: 0, scanGeneration: 1 });
    expect(after?.lastSourceIri).toBeUndefined();
    expect(await journal.listReferences(SCOPE, { limit: 10 })).toEqual([]);
  });
});
