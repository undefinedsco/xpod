import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getSqliteRuntime, type SqliteDatabase } from '../../../src/storage/SqliteRuntime';
import {
  InMemoryMatrixEventJournal,
  SqlMatrixEventJournal,
  type MatrixEventJournal,
} from '../../../src/api/matrix/MatrixEventJournal';

const scope = 'https://pod.example/alice/';
const candidate = { eventId: '$first', createdAt: 1_700_000_000_000, contentHash: 'hash-first' };
const opened: SqliteDatabase[] = [];
const directories: string[] = [];

function openSqlJournal(filename: string): MatrixEventJournal {
  const runtime = getSqliteRuntime();
  const database = runtime.openDatabase(filename);
  opened.push(database);
  return new SqlMatrixEventJournal(runtime.createDrizzleDatabase(database));
}

afterEach(() => {
  for (const database of opened.splice(0)) {
    database.close();
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const [ name, create ] of [
  [ 'memory', (): MatrixEventJournal => new InMemoryMatrixEventJournal() ],
  [ 'SQLite', (): MatrixEventJournal => openSqlJournal(':memory:') ],
] as const) {
  describe(name, () => {
    it('atomically preserves the first reservation and isolates Pod scopes', async () => {
      const journal = create();
      const reservations = await Promise.all(Array.from({ length: 30 }, (_, index) =>
        journal.reserveTransaction(scope, 'device-room-type-txn', { ...candidate, eventId: `$${index}` })));
      expect(new Set(reservations.map((entry) => entry.eventId)).size).toBe(1);
      expect(await journal.reserveTransaction('other-pod', 'device-room-type-txn', candidate)).toEqual(candidate);
      const first = reservations[0];
      first.eventId = '$tampered';
      expect((await journal.reserveTransaction(scope, 'device-room-type-txn', candidate)).eventId).not.toBe('$tampered');
    });

    it('registers concurrent duplicates once and assigns increasing sequences to late events', async () => {
      const journal = create();
      expect(await journal.getHighWatermark(scope)).toBe(0);
      const duplicateSequences = await Promise.all(Array.from({ length: 30 }, () => journal.registerEvent(scope, '!room', '$same')));
      expect(new Set(duplicateSequences).size).toBe(1);
      const first = duplicateSequences[0];
      const late = await journal.registerEvent(scope, '!room', '$late-old-timestamp');
      expect(late).toBeGreaterThan(first);
      expect(await journal.registerEvent(scope, '!room', '$same')).toBe(first);
      expect(await journal.getHighWatermark(scope)).toBe(late);
      const other = await journal.registerEvent('other-pod', '!room', '$same');
      expect(other).toBeGreaterThan(late);
      expect(await journal.getHighWatermark(scope)).toBe(late);
    });
  });
}

describe('SQLite persistence', () => {
  it('looks up an existing event without requiring a database write', async () => {
    const journal = openSqlJournal(':memory:');
    const sequence = await journal.registerEvent(scope, '!room', '$existing');
    opened[opened.length - 1].pragma('query_only = ON');
    expect(await journal.registerEvent(scope, '!room', '$existing')).toBe(sequence);
  });

  it('preserves reservations and cursors when the connection is reopened', async () => {
    const root = path.resolve('.test-data/matrix-event-journal');
    mkdirSync(root, { recursive: true });
    const directory = mkdtempSync(path.join(root, 'journal-'));
    directories.push(directory);
    const filename = path.join(directory, 'journal.sqlite');
    const first = openSqlJournal(filename);
    await first.reserveTransaction(scope, 'txn', candidate);
    const sequence = await first.registerEvent(scope, '!room', candidate.eventId);
    opened.pop()!.close();
    const reopened = openSqlJournal(filename);
    expect(await reopened.reserveTransaction(scope, 'txn', { ...candidate, eventId: '$different' })).toEqual(candidate);
    expect(await reopened.registerEvent(scope, '!room', candidate.eventId)).toBe(sequence);
    expect(await reopened.getHighWatermark(scope)).toBe(sequence);
    expect(await reopened.registerEvent(scope, '!room', '$next')).toBeGreaterThan(sequence);
    const secondConnection = openSqlJournal(filename);
    const competing = await Promise.all([
      reopened.reserveTransaction(scope, 'competing', candidate),
      secondConnection.reserveTransaction(scope, 'competing', { ...candidate, eventId: '$loser' }),
    ]);
    expect(competing[0]).toEqual(competing[1]);
    const registrations = await Promise.all([
      reopened.registerEvent(scope, '!room', '$shared'),
      secondConnection.registerEvent(scope, '!room', '$shared'),
    ]);
    expect(registrations[0]).toBe(registrations[1]);
  });
});
