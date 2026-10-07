import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { messageResource } from '@undefineds.co/models';
import { matrixHarness, MATRIX_TEST_SERVER_NAME } from '../../helpers/MatrixMemoryDatabase';
import { PodMatrixStore } from '../../../src/api/matrix/PodMatrixStore';
import { roomDirectoryIri } from '../../../src/api/matrix/roomResources';
import { getSqliteRuntime, type SqliteDatabase } from '../../../src/storage/SqliteRuntime';
import { SqlMatrixEventJournal } from '../../../src/api/matrix/MatrixEventJournal';

const opened: SqliteDatabase[] = [];
const directories: string[] = [];

function openJournal(filename: string): { journal: SqlMatrixEventJournal; database: SqliteDatabase } {
  const runtime = getSqliteRuntime();
  const database = runtime.openDatabase(filename);
  database.pragma('busy_timeout = 10000');
  opened.push(database);
  return { journal: new SqlMatrixEventJournal(runtime.createDrizzleDatabase(database)), database };
}

function tempFile(): string {
  const directory = mkdtempSync(path.join(process.cwd(), '.test-data', 'source-resume-'));
  directories.push(directory);
  return path.join(directory, 'journal.sqlite');
}

afterEach(() => {
  for (const database of opened.splice(0)) {
    try { database.close(); } catch { /* already closed; persistence is asserted elsewhere */ }
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** Push a native message row straight into the Pod (no store write, no journal reference). */
function pushNative(rows: Map<any, any[]>, exemplar: any, eventId: string, createdAt: number, body: string): void {
  rows.get(messageResource)!.push({ ...exemplar,
    id: messageResource.buildId({ id: eventId, parent: exemplar.parent, createdAt: new Date(createdAt).toISOString() }),
    content: body,
    createdAt: new Date(createdAt).toISOString(),
    metadata: {},
  });
}

/** A source that reports one room dirty until its whole cycle is settled. */
function dirtyRoomSource(roomRef: { roomId: string }) {
  let dirty = true;
  return {
    pending: async () => ({ trust: 'changed' as const, rooms: dirty ? [ roomRef.roomId ] : [], snapshot: {} }),
    settle: async ({ rooms }: { rooms: readonly string[] }) => { if (rooms.includes(roomRef.roomId)) dirty = false; },
  };
}

describe('durable resumable source discovery', () => {
  it('resumes past a full source page at the next SOURCE row without re-reading the prefix', async () => {
    const roomRef = { roomId: '' };
    const source = dirtyRoomSource(roomRef);
    const { store, context, rows } = matrixHarness({ roomChanges: source, roomChangeFullPassMs: 10 ** 9 });
    roomRef.roomId = (await store.createRoom({}, context)).roomId;
    await store.sendEvent(roomRef.roomId, 'm.room.message', 'template', { body: 'template' }, context);
    const exemplar = rows.get(messageResource)!.find(row => row.role === 'user');
    const total = 520;
    for (let index = 0; index < total; index += 1) pushNative(rows, exemplar, `native-${String(index).padStart(3, '0')}`, 1000 + index, `native ${index}`);

    const directory = roomDirectoryIri(context.podUrl, roomRef.roomId);
    const checkpointScope = context.podUrl;
    // First request reads one page and leaves the room incomplete (checkpoint advanced to row 500).
    await store.sync(context, { timeout: 0 });
    const afterFirst = await (store as any).journal.getReconcileCheckpoint(checkpointScope, directory);
    expect(afterFirst.lastSourceIri).toContain('native-499');
    const firstCount = (await (store as any).journal.listReferences(checkpointScope, { roomId: roomRef.roomId, limit: 4096 })).length;

    // Second request resumes at native-500 and finishes the cycle with the remaining rows.
    await store.sync(context, { timeout: 0 });
    const references = await (store as any).journal.listReferences(checkpointScope, { roomId: roomRef.roomId, limit: 4096 });
    expect(references.length).toBeGreaterThan(firstCount);
    const nativeRows: string[] = references.map((reference: { messageIri?: string }) => reference.messageIri ?? '');
    for (const index of [ 0, 499, 500, total - 1 ]) {
      expect(nativeRows.some(iri => iri.endsWith(`#native-${String(index).padStart(3, '0')}`))).toBe(true);
    }
    // A completed cycle rotates from the beginning, so the prefix is not a permanent cutoff.
    const afterComplete = await (store as any).journal.getReconcileCheckpoint(checkpointScope, directory);
    expect(afterComplete.lastSourceIri).toBeUndefined();
    expect(afterComplete.scanGeneration).toBeGreaterThan(afterFirst.scanGeneration);
  });

  it('durably resumes an unfinished checkpoint after a Store reopen', async () => {
    const filename = tempFile();
    const roomRef = { roomId: '' };
    const source = dirtyRoomSource(roomRef);
    const first = openJournal(filename);
    const harness = matrixHarness({ roomChanges: source, roomChangeFullPassMs: 10 ** 9 });
    roomRef.roomId = (await harness.store.createRoom({}, harness.context)).roomId;
    await harness.store.sendEvent(roomRef.roomId, 'm.room.message', 'template', { body: 'template' }, harness.context);
    const exemplar = harness.rows.get(messageResource)!.find(row => row.role === 'user');
    for (let index = 0; index < 520; index += 1) pushNative(harness.rows, exemplar, `resume-${String(index).padStart(3, '0')}`, 2000 + index, `resume ${index}`);

    const directory = roomDirectoryIri(harness.context.podUrl, roomRef.roomId);
    const firstStore = new PodMatrixStore({
      serverName: MATRIX_TEST_SERVER_NAME,
      roomChanges: source,
      roomChangeFullPassMs: 10 ** 9,
      journal: first.journal,
    });
    await firstStore.sync(harness.context, { timeout: 0 });
    const midway = await first.journal.getReconcileCheckpoint(harness.context.podUrl, directory);
    expect(midway?.lastSourceIri).toContain('resume-499');

    // A brand-new Store over the same durable journal continues the unfinished cycle.
    const second = new PodMatrixStore({
      serverName: MATRIX_TEST_SERVER_NAME,
      roomChanges: source,
      roomChangeFullPassMs: 10 ** 9,
      journal: openJournal(filename).journal,
    });
    await second.sync(harness.context, { timeout: 0 });
    const references = await (second as any).journal.listReferences(harness.context.podUrl, { roomId: roomRef.roomId, limit: 4096 });
    const resumedRows: string[] = references.map((reference: { messageIri?: string }) => reference.messageIri ?? '');
    expect(resumedRows.some(iri => iri.endsWith('#resume-519'))).toBe(true);
    expect(references.length).toBeGreaterThanOrEqual(521);
  });

  it('publishes ZERO references and keeps the hint when the atomic publish is aborted', async () => {
    const filename = tempFile();
    const roomRef = { roomId: '' };
    const source = dirtyRoomSource(roomRef);
    const { journal, database } = openJournal(filename);
    const harness = matrixHarness({ roomChanges: source, roomChangeFullPassMs: 10 ** 9 });
    roomRef.roomId = (await harness.store.createRoom({}, harness.context)).roomId;
    await harness.store.sendEvent(roomRef.roomId, 'm.room.message', 'template', { body: 'template' }, harness.context);
    const exemplar = harness.rows.get(messageResource)!.find(row => row.role === 'user');
    pushNative(harness.rows, exemplar, 'abort-a', 3000, 'abort a');
    pushNative(harness.rows, exemplar, 'abort-b', 3001, 'abort b');
    // Touch the journal so its tables exist before the trigger is installed on them.
    await journal.getEpoch(harness.context.podUrl);
    database.exec(`
      CREATE TRIGGER abort_second BEFORE INSERT ON xpod_matrix_event_refs
      WHEN NEW.message_iri LIKE '%#abort-b'
      BEGIN SELECT RAISE(ABORT, 'boom'); END
    `);
    const store = new PodMatrixStore({
      serverName: MATRIX_TEST_SERVER_NAME,
      roomChanges: source,
      roomChangeFullPassMs: 10 ** 9,
      journal,
    });
    await expect(store.sync(harness.context, { timeout: 0 })).rejects.toThrow();

    const directory = roomDirectoryIri(harness.context.podUrl, roomRef.roomId);
    const checkpoint = await journal.getReconcileCheckpoint(harness.context.podUrl, directory);
    expect(checkpoint).toMatchObject({ revision: 0, scanGeneration: 1 });
    expect(checkpoint?.lastSourceIri).toBeUndefined();
    expect((await journal.listReferences(harness.context.podUrl, { roomId: roomRef.roomId, limit: 4096 })).length).toBe(0);
    // The dirty hint survived the failure, so a later request retries the same page and, once the
    // blocking trigger is gone, publishes the exact set and completes.
    let settledRooms: readonly string[] | undefined;
    const retrySource = {
      pending: async () => ({ trust: 'changed' as const, rooms: [ roomRef.roomId ], snapshot: {} }),
      settle: async ({ rooms }: { rooms: readonly string[] }) => { settledRooms = rooms; },
    };
    const retryStore = new PodMatrixStore({
      serverName: MATRIX_TEST_SERVER_NAME,
      roomChanges: retrySource,
      roomChangeFullPassMs: 10 ** 9,
      journal,
    });
    database.exec('DROP TRIGGER abort_second');
    await retryStore.sync(harness.context, { timeout: 0 });
    const published = await journal.listReferences(harness.context.podUrl, { roomId: roomRef.roomId, limit: 4096 });
    expect(published.some((reference: { messageIri?: string }) => (reference.messageIri ?? '').endsWith('#abort-a'))).toBe(true);
    expect(published.some((reference: { messageIri?: string }) => (reference.messageIri ?? '').endsWith('#abort-b'))).toBe(true);
    expect(settledRooms).toContain(roomRef.roomId);
  });

  it('lets exactly one of two source consumers win the same CAS', async () => {
    const filename = tempFile();
    const roomRef = { roomId: '' };
    const { journal } = openJournal(filename);
    const harness = matrixHarness({ roomChanges: dirtyRoomSource(roomRef), roomChangeFullPassMs: 10 ** 9 });
    roomRef.roomId = (await harness.store.createRoom({}, harness.context)).roomId;
    await harness.store.sendEvent(roomRef.roomId, 'm.room.message', 'template', { body: 'template' }, harness.context);
    const exemplar = harness.rows.get(messageResource)!.find(row => row.role === 'user');
    for (let index = 0; index < 10; index += 1) pushNative(harness.rows, exemplar, `cas-${index}`, 4000 + index, `cas ${index}`);

    const directory = roomDirectoryIri(harness.context.podUrl, roomRef.roomId);
    const started = await journal.beginReconcileScan(harness.context.podUrl, { sourceUri: directory });
    const page = {
      sourceUri: directory,
      epoch: started.epoch,
      scanGeneration: started.scanGeneration,
      revision: started.revision,
      references: [],
      complete: true,
    };
    const [ resultA, resultB ] = await Promise.all([
      journal.publishReferencePage(harness.context.podUrl, page),
      journal.publishReferencePage(harness.context.podUrl, page),
    ]);
    expect([ resultA.advanced, resultB.advanced ].filter(Boolean)).toHaveLength(1);
    const final = await journal.getReconcileCheckpoint(harness.context.podUrl, directory);
    expect(final?.revision).toBe(1);
  });

  it('keeps an older-than-current timestamp reachable after a completed cycle', async () => {
    const roomRef = { roomId: '' };
    // This source keeps reporting the room, so each sync runs discovery; the point under test is
    // that a completed cycle restarts from the beginning rather than forever advancing a cursor.
    const source = {
      pending: async () => ({ trust: 'changed' as const, rooms: [ roomRef.roomId ], snapshot: {} }),
      settle: async () => undefined,
    };
    const { store, context, rows } = matrixHarness({ roomChanges: source, roomChangeFullPassMs: 10 ** 9 });
    roomRef.roomId = (await store.createRoom({}, context)).roomId;
    await store.sendEvent(roomRef.roomId, 'm.room.message', 'template', { body: 'template' }, context);
    const exemplar = rows.get(messageResource)!.find(row => row.role === 'user');
    pushNative(rows, exemplar, 'old-row', 10, 'ancient row');
    const directory = roomDirectoryIri(context.podUrl, roomRef.roomId);

    // Finish a cycle, then push a row whose timestamp is older than the completed cycle's start.
    await store.sync(context, { timeout: 0 });
    const complete = await (store as any).journal.getReconcileCheckpoint(context.podUrl, directory);
    expect(complete.lastSourceIri).toBeUndefined();
    pushNative(rows, exemplar, 'late-old', 5, 'older than everything');

    await store.sync(context, { timeout: 0 });
    const references = await (store as any).journal.listReferences(context.podUrl, { roomId: roomRef.roomId, limit: 4096 });
    expect(references.some((reference: { messageIri?: string }) => (reference.messageIri ?? '').endsWith('#late-old'))).toBe(true);
  });

  it('requires an explicit resync before reusing a stale checkpoint after an index-loss epoch bump', async () => {
    const filename = tempFile();
    const roomRef = { roomId: '' };
    const { journal } = openJournal(filename);
    const harness = matrixHarness({ roomChanges: dirtyRoomSource(roomRef), roomChangeFullPassMs: 10 ** 9 });
    roomRef.roomId = (await harness.store.createRoom({}, harness.context)).roomId;
    await harness.store.sendEvent(roomRef.roomId, 'm.room.message', 'template', { body: 'template' }, harness.context);
    const exemplar = harness.rows.get(messageResource)!.find(row => row.role === 'user');
    for (let index = 0; index < 520; index += 1) pushNative(harness.rows, exemplar, `epoch-${String(index).padStart(3, '0')}`, 5000 + index, `epoch ${index}`);

    const directory = roomDirectoryIri(harness.context.podUrl, roomRef.roomId);
    const firstStore = new PodMatrixStore({
      serverName: MATRIX_TEST_SERVER_NAME, roomChanges: dirtyRoomSource(roomRef),
      roomChangeFullPassMs: 10 ** 9, journal,
    });
    await firstStore.sync(harness.context, { timeout: 0 });
    const stale = await journal.getReconcileCheckpoint(harness.context.podUrl, directory);
    expect(stale?.lastSourceIri).toContain('epoch-499');

    // Simulate an operational-index loss: the epoch changes, so old tokens/checkpoints are invalid.
    await journal.bumpEpoch(harness.context.podUrl);
    // A fresh store must begin a new cycle rather than resume the stale checkpoint.
    const secondStore = new PodMatrixStore({
      serverName: MATRIX_TEST_SERVER_NAME, roomChanges: dirtyRoomSource(roomRef),
      roomChangeFullPassMs: 10 ** 9, journal,
    });
    await secondStore.sync(harness.context, { timeout: 0 });
    const restarted = await journal.getReconcileCheckpoint(harness.context.podUrl, directory);
    expect(restarted?.epoch).not.toBe(stale?.epoch);
    // The new cycle started from the beginning, so it read the first page again rather than
    // resuming the stale checkpoint's next page.
    expect(restarted?.lastSourceIri).toContain('epoch-499');
    expect(restarted?.revision).toBe(1);
  });
});
