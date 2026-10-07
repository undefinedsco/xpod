import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { getSqliteRuntime, type SqliteDatabase } from '../../../src/storage/SqliteRuntime';
import { InMemoryMatrixEventJournal, SqlMatrixEventJournal, type MatrixEventJournal } from '../../../src/api/matrix/MatrixEventJournal';

const scope = 'https://pod.example/alice/';
const databases: SqliteDatabase[] = [];
const directories: string[] = [];
const sqlite = (): MatrixEventJournal => {
  const runtime = getSqliteRuntime();
  const database = runtime.openDatabase(':memory:');
  databases.push(database);
  return new SqlMatrixEventJournal(runtime.createDrizzleDatabase(database));
};
afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

for (const [ name, create ] of [
  [ 'memory', () => new InMemoryMatrixEventJournal() ],
  [ 'SQLite', sqlite ],
] as const) {
  describe(`cursor journal independent acceptance (${name})`, () => {
    it('returns the first exact reference when a retry proposes a different resource and time', async () => {
      const journal = create();
      const first = await journal.registerReference(scope, {
        roomId: '!room', eventId: '$first', messageIri: `${scope}2026/10/02/messages.ttl#first`, createdAt: 100,
      });
      const replay = await journal.registerReference(scope, {
        roomId: '!room', eventId: '$first', messageIri: `${scope}2026/10/03/messages.ttl#other`, createdAt: 200,
      });
      expect(replay).toEqual(first);
      expect(await journal.listReferences(scope, { limit: 1 })).toEqual([ first ]);
    });

    it('holds a fixed page-set boundary while new references are published', async () => {
      const journal = create();
      const first = await journal.registerReference(scope, { roomId: '!room', eventId: '$first', createdAt: 100 });
      const throughSequence = await journal.getHighWatermark(scope);
      await journal.registerReference(scope, { roomId: '!room', eventId: '$later', createdAt: 1 });
      const options = { afterSequence: 0, throughSequence, limit: 20 };
      expect(await journal.listReferences(scope, options)).toEqual([ first ]);
    });

    it('does not reuse an old epoch after the operational index is lost', async () => {
      const original = create();
      await original.registerReference(scope, { roomId: '!room', eventId: '$first', createdAt: 100 });
      const epoch = await original.getEpoch(scope);
      // A new empty store represents loss of all rebuildable index tables, not a connection reopen.
      const rebuilt = create();
      await rebuilt.registerReference(scope, { roomId: '!room', eventId: '$first', createdAt: 100 });
      expect(await rebuilt.getEpoch(scope)).not.toBe(epoch);
    });

    it('converges concurrent registrations on the same first stored reference', async () => {
      const journal = create();
      const published = await Promise.all(Array.from({ length: 16 }, (_, index) => journal.registerReference(scope, {
        roomId: '!room', eventId: '$concurrent', messageIri: `${scope}messages.ttl#candidate-${index}`, createdAt: index,
      })));
      const stored = await journal.listReferences(scope, { limit: 20 });
      expect(stored).toHaveLength(1);
      for (const result of published) expect(result).toEqual(stored[0]);
    });

    it('cannot backfill a legacy sequence behind an already acknowledged published watermark', async () => {
      const journal = create();
      await journal.registerEvent(scope, '!room', '$legacy');
      await journal.registerReference(scope, {
        roomId: '!room', eventId: '$later', messageIri: `${scope}messages.ttl#later`, createdAt: 200,
      });
      const epoch = await journal.getEpoch(scope);
      const acknowledged = await (journal as MatrixEventJournal & {
        getPublishedReferenceWatermark(scope: string): Promise<number>;
      }).getPublishedReferenceWatermark(scope);
      const discovered = await journal.registerReference(scope, {
        roomId: '!room', eventId: '$legacy', messageIri: `${scope}messages.ttl#legacy`, createdAt: 100,
      });
      if (await journal.getEpoch(scope) === epoch) {
        expect(discovered.sequence, 'a newly discovered legacy row must be delivered or explicitly invalidate the old epoch')
          .toBeGreaterThan(acknowledged);
        expect(await journal.listReferences(scope, { afterSequence: acknowledged, limit: 20 })).toEqual([ discovered ]);
      }
    });
  });
}

describe('cursor publication on actual SQLite', () => {
  it('rolls back the sequence if publishing its reference fails', async () => {
    const runtime = getSqliteRuntime();
    const database = runtime.openDatabase(':memory:');
    databases.push(database);
    const journal = new SqlMatrixEventJournal(runtime.createDrizzleDatabase(database));
    await journal.getEpoch(scope);
    database.exec(`CREATE TRIGGER reject_reference BEFORE INSERT ON xpod_matrix_event_refs
      WHEN NEW.event_id = '$reject' BEGIN SELECT RAISE(ABORT, 'injected publication failure'); END`);
    await expect(journal.registerReference(scope, {
      roomId: '!room', eventId: '$reject', messageIri: `${scope}messages.ttl#reject`, createdAt: 100,
    })).rejects.toThrow();
    expect(await journal.getHighWatermark(scope), 'an aborted publication must not leave a visible cursor sequence').toBe(0);
    expect(await journal.listReferences(scope, { limit: 20 })).toEqual([]);
    database.exec('DROP TRIGGER reject_reference');
    const retry = await journal.registerReference(scope, {
      roomId: '!room', eventId: '$reject', messageIri: `${scope}messages.ttl#reject`, createdAt: 100,
    });
    expect(await journal.listReferences(scope, { limit: 20 })).toEqual([ retry ]);
  });

  it('preserves the epoch and references across an actual database close and reopen', async () => {
    const root = path.resolve('.test-data/cursor-journal');
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(path.join(root, 'reopen-'));
    directories.push(directory);
    const filename = path.join(directory, 'journal.sqlite');
    const runtime = getSqliteRuntime();
    const originalDatabase = runtime.openDatabase(filename);
    const original = new SqlMatrixEventJournal(runtime.createDrizzleDatabase(originalDatabase));
    let epoch: string;
    let reference;
    try {
      reference = await original.registerReference(scope, {
        roomId: '!room', eventId: '$persisted', messageIri: `${scope}messages.ttl#persisted`, createdAt: 100,
      });
      epoch = await original.getEpoch(scope);
    } finally {
      originalDatabase.close();
    }
    const reopenedDatabase = runtime.openDatabase(filename);
    databases.push(reopenedDatabase);
    const reopened = new SqlMatrixEventJournal(runtime.createDrizzleDatabase(reopenedDatabase));
    expect(await reopened.getEpoch(scope)).toBe(epoch);
    expect(await reopened.listReferences(scope, { limit: 1 })).toEqual([ reference ]);
  });

  it('does not publish legacy event-only registrations as an exact-reference watermark', async () => {
    const journal = sqlite();
    const reference = await journal.registerReference(scope, {
      roomId: '!room', eventId: '$published', messageIri: `${scope}messages.ttl#published`, createdAt: 100,
    });
    await journal.registerEvent(scope, '!room', '$legacy-without-reference');
    const publishedWatermark = (journal as MatrixEventJournal & {
      getPublishedReferenceWatermark(scope: string): Promise<number>;
    }).getPublishedReferenceWatermark;
    expect(publishedWatermark, 'sync needs the fully published reference boundary, not MAX(event sequence)').toBeTypeOf('function');
    expect(await publishedWatermark.call(journal, scope)).toBe(reference.sequence);
  });
});
