import { messageResource } from '@undefineds.co/models';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { matrixHarness, MATRIX_TEST_SERVER_NAME } from '../../helpers/MatrixMemoryDatabase';
import { PodMatrixStore } from '../../../src/api/matrix/PodMatrixStore';
import type { MatrixRoomChangeSource, MatrixRoomChangeSnapshot } from '../../../src/api/matrix/PodMatrixStore';
import { roomDirectoryIri } from '../../../src/api/matrix/roomResources';
import { getSqliteRuntime, type SqliteDatabase } from '../../../src/storage/SqliteRuntime';
import { SqlMatrixEventJournal } from '../../../src/api/matrix/MatrixEventJournal';

const openedDatabases: SqliteDatabase[] = [];
const tempDirectories: string[] = [];

function openSqlJournal(filename: string): { journal: SqlMatrixEventJournal; database: SqliteDatabase } {
  const runtime = getSqliteRuntime();
  const database = runtime.openDatabase(filename);
  database.pragma('busy_timeout = 10000');
  openedDatabases.push(database);
  return { journal: new SqlMatrixEventJournal(runtime.createDrizzleDatabase(database)), database };
}

function tempJournalFile(): string {
  const directory = mkdtempSync(path.join(process.cwd(), '.test-data', 'cycle-observation-'));
  tempDirectories.push(directory);
  return path.join(directory, 'journal.sqlite');
}

afterEach(() => {
  for (const database of openedDatabases.splice(0)) {
    try { database.close(); } catch { /* persistence is asserted elsewhere */ }
  }
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});


/**
 * A versioned source that models the reported failure: a room is dirty in version 1, the source
 * has 600 rows, the first source page publishes 500, then between pages a late row (timestamp 1)
 * arrives and the room is dirtied again in version 2. Finishing the *v1* cycle must not settle the
 * v2 hint, and the next cycle must discover the late row exactly once.
 */
function versionedSource(roomRef: { roomId: string }) {
  let version = 0;
  const dirty = new Map<string, number>();
  const reconcile = new Map<string, number>();
  const observations = new Map<string, { versions: Map<string, number>; reconcile: Map<string, number>; version: number }>();
  let counter = 0;
  const mark = (roomId: string) => { dirty.set(roomId, ++counter); version = counter; };
  const markReconcile = (roomId: string) => { reconcile.set(roomId, ++counter); };
  return {
    version: () => version,
    mark,
    markReconcile,
    source: {
      pending: async (): Promise<MatrixRoomChangeSnapshot> => {
        const token = `obs-${++counter}`;
        observations.set(token, { versions: new Map(dirty), reconcile: new Map(reconcile), version });
        return {
          trust: dirty.size === 0 && reconcile.size === 0 ? 'changed' : 'changed',
          rooms: [ ...dirty.keys() ],
          reconcileRooms: [ ...reconcile.keys() ],
          documentChanges: [],
          snapshot: token,
        };
      },
      settle: async ({ rooms, reconcileRooms, snapshot, full }: Parameters<MatrixRoomChangeSource['settle']>[0]) => {
        const observed = typeof snapshot === 'string' ? observations.get(snapshot) : undefined;
        if (!observed) return;
        const readRooms = new Set(full ? observed.versions.keys() : rooms);
        for (const roomId of readRooms) {
          if (observed.versions.get(roomId) === dirty.get(roomId)) dirty.delete(roomId);
        }
        for (const roomId of reconcileRooms ?? []) {
          if (observed.reconcile.get(roomId) === reconcile.get(roomId)) reconcile.delete(roomId);
        }
      },
    } as MatrixRoomChangeSource,
  };
}

function pushNative(rows: Map<any, any[]>, exemplar: any, eventId: string, createdAt: number, body: string): void {
  rows.get(messageResource)!.push({ ...exemplar,
    id: messageResource.buildId({ id: eventId, parent: exemplar.parent, createdAt: new Date(createdAt).toISOString() }),
    content: body,
    createdAt: new Date(createdAt).toISOString(),
    metadata: {},
  });
}

describe('source cycle observation retention', () => {
  it('does not settle a new hint when an older cycle completes, and discovers the late row next cycle', async () => {
    const roomRef = { roomId: '' };
    const versioned = versionedSource(roomRef);
    const { store, context, rows } = matrixHarness({ roomChanges: versioned.source, roomChangeFullPassMs: 10 ** 9 });
    roomRef.roomId = (await store.createRoom({}, context)).roomId;
    await store.sendEvent(roomRef.roomId, 'm.room.message', 'template', { body: 'template' }, context);
    const exemplar = rows.get(messageResource)!.find(row => row.role === 'user');
    // 600 source rows so the first page (500) does not exhaust the source.
    for (let index = 0; index < 600; index += 1) pushNative(rows, exemplar, `v1-${String(index).padStart(4, '0')}`, 100_000 + index, `v1 row ${index}`);

    // Version 1: the room is dirty and a cycle starts.
    versioned.mark(roomRef.roomId);
    const first = await store.sync(context, { timeout: 0 });
    expect(first.rooms.join[roomRef.roomId]).toBeDefined();
    const directory = roomDirectoryIri(context.podUrl, roomRef.roomId);
    const midway = await (store as any).journal.getReconcileCheckpoint(context.podUrl, directory);
    expect(midway?.lastSourceIri).toContain('v1-0499');

    // Between pages: a late row (timestamp 1) arrives and the room is dirtied again (version 2).
    pushNative(rows, exemplar, 'late-old', 1, 'late old row');
    const v2 = await versioned.source.pending({ scope: context.podUrl });
    expect(v2.rooms).toContain(roomRef.roomId);

    // The tail request finishes the v1 cycle. It must NOT settle the v2 hint.
    await store.sync(context, { timeout: 0 });
    const afterComplete = await versioned.source.pending({ scope: context.podUrl });
    expect(afterComplete.rooms, 'the v2 hint survives an older cycle completion').toContain(roomRef.roomId);

    // The next cycle delivers the late row exactly once.
    await store.sync(context, { timeout: 0 });
    const references = await (store as any).journal.listReferences(context.podUrl, { roomId: roomRef.roomId, limit: 8192 });
    const late = references.filter((reference: { messageIri?: string }) => (reference.messageIri ?? '').endsWith('#late-old'));
    expect(late).toHaveLength(1);
  });

  it('retains the v2 hint across a real SQLite Store close and reopen', async () => {
    const filename = tempJournalFile();
    const roomRef = { roomId: '' };
    const versioned = versionedSource(roomRef);
    const { journal } = openSqlJournal(filename);
    const harness = matrixHarness({ roomChanges: versioned.source, roomChangeFullPassMs: 10 ** 9 });
    roomRef.roomId = (await harness.store.createRoom({}, harness.context)).roomId;
    await harness.store.sendEvent(roomRef.roomId, 'm.room.message', 'template', { body: 'template' }, harness.context);
    const exemplar = harness.rows.get(messageResource)!.find(row => row.role === 'user');
    for (let index = 0; index < 600; index += 1) pushNative(harness.rows, exemplar, `r-${String(index).padStart(4, '0')}`, 100_000 + index, `r ${index}`);

    versioned.mark(roomRef.roomId);
    const firstStore = new PodMatrixStore({ serverName: MATRIX_TEST_SERVER_NAME, roomChanges: versioned.source, roomChangeFullPassMs: 10 ** 9, journal });
    await firstStore.sync(harness.context, { timeout: 0 });
    const directory = roomDirectoryIri(harness.context.podUrl, roomRef.roomId);
    const midway = await journal.getReconcileCheckpoint(harness.context.podUrl, directory);
    expect(midway?.view).toContain('"observation"');

    pushNative(harness.rows, exemplar, 'late-old', 1, 'late old row');
    await versioned.source.pending({ scope: harness.context.podUrl });

    // A brand-new Store over the same durable journal finishes the v1 cycle; the v2 hint survives.
    const reopened = openSqlJournal(filename).journal;
    const secondStore = new PodMatrixStore({ serverName: MATRIX_TEST_SERVER_NAME, roomChanges: versioned.source, roomChangeFullPassMs: 10 ** 9, journal: reopened });
    await secondStore.sync(harness.context, { timeout: 0 });
    expect((await versioned.source.pending({ scope: harness.context.podUrl })).rooms).toContain(roomRef.roomId);

    await secondStore.sync(harness.context, { timeout: 0 });
    const references = await reopened.listReferences(harness.context.podUrl, { roomId: roomRef.roomId, limit: 8192 });
    expect(references.filter((reference: { messageIri?: string }) => (reference.messageIri ?? '').endsWith('#late-old'))).toHaveLength(1);
  });

  it('keeps advancing the cycle when a full page is entirely made of already-known rows', async () => {
    const roomRef = { roomId: '' };
    const versioned = versionedSource(roomRef);
    const { store, context, rows } = matrixHarness({ roomChanges: versioned.source, roomChangeFullPassMs: 10 ** 9 });
    roomRef.roomId = (await store.createRoom({}, context)).roomId;
    await store.sendEvent(roomRef.roomId, 'm.room.message', 'template', { body: 'template' }, context);
    const exemplar = rows.get(messageResource)!.find(row => row.role === 'user');
    for (let index = 0; index < 600; index += 1) pushNative(rows, exemplar, `k-${String(index).padStart(4, '0')}`, 200_000 + index, `k ${index}`);
    const directory = roomDirectoryIri(context.podUrl, roomRef.roomId);
    versioned.mark(roomRef.roomId);

    // First page: 500 rows, cursor at k-0499. Second page: rows are all already known, but the
    // cursor must still advance to the last source row of that page (known rows are not a stop).
    await store.sync(context, { timeout: 0 });
    const midway = await (store as any).journal.getReconcileCheckpoint(context.podUrl, directory);
    expect(midway?.lastSourceIri).toContain('k-0499');
    await store.sync(context, { timeout: 0 });
    const completed = await (store as any).journal.getReconcileCheckpoint(context.podUrl, directory);
    // The short page completed the cycle, so the cursor was cleared and the generation rotated.
    expect(completed?.lastSourceIri).toBeUndefined();
    expect(completed?.scanGeneration).toBeGreaterThan(midway?.scanGeneration ?? 0);
  });

  it('binds the first page view under a single CAS and rejects a competing second view', async () => {
    const roomRef = { roomId: '' };
    const versioned = versionedSource(roomRef);
    const { store, context, rows } = matrixHarness({ roomChanges: versioned.source, roomChangeFullPassMs: 10 ** 9 });
    roomRef.roomId = (await store.createRoom({}, context)).roomId;
    await store.sendEvent(roomRef.roomId, 'm.room.message', 'template', { body: 'template' }, context);
    const exemplar = rows.get(messageResource)!.find(row => row.role === 'user');
    for (let index = 0; index < 600; index += 1) pushNative(rows, exemplar, `c-${String(index).padStart(4, '0')}`, 300_000 + index, `c ${index}`);
    const directory = roomDirectoryIri(context.podUrl, roomRef.roomId);
    const journal = (store as any).journal;
    const scope = context.podUrl;
    const started = await journal.beginReconcileScan(scope, { sourceUri: directory });
    const page = (view: string) => ({
      sourceUri: directory, epoch: started.epoch, scanGeneration: started.scanGeneration, revision: started.revision,
      references: [], complete: false,
      next: { roomId: roomRef.roomId, last: { createdAt: 300_000, sourceIri: `${directory}2026/01/01/messages.ttl#c-0000` } },
      view,
    });
    const viewA = JSON.stringify({ version: 1, upper: null, observation: 'a' });
    const viewB = JSON.stringify({ version: 1, upper: null, observation: 'b' });
    const [ resultA, resultB ] = await Promise.all([
      journal.publishReferencePage(scope, page(viewA)),
      journal.publishReferencePage(scope, page(viewB)),
    ]);
    expect([ resultA.advanced, resultB.advanced ].filter(Boolean)).toHaveLength(1);
    const final = await journal.getReconcileCheckpoint(scope, directory);
    // Exactly one view was bound; the competing one left no trace.
    expect([ viewA, viewB ]).toContain(final?.view);
  });

  it('leaves the bound view and cursor unchanged when a later page is rolled back', async () => {
    const filename = tempJournalFile();
    const roomRef = { roomId: '' };
    const versioned = versionedSource(roomRef);
    const { journal, database } = openSqlJournal(filename);
    const harness = matrixHarness({ roomChanges: versioned.source, roomChangeFullPassMs: 10 ** 9 });
    roomRef.roomId = (await harness.store.createRoom({}, harness.context)).roomId;
    await harness.store.sendEvent(roomRef.roomId, 'm.room.message', 'template', { body: 'template' }, harness.context);
    const exemplar = harness.rows.get(messageResource)!.find(row => row.role === 'user');
    for (let index = 0; index < 600; index += 1) pushNative(harness.rows, exemplar, `rb-${String(index).padStart(4, '0')}`, 400_000 + index, `rb ${index}`);
    const directory = roomDirectoryIri(harness.context.podUrl, roomRef.roomId);
    const store = new PodMatrixStore({ serverName: MATRIX_TEST_SERVER_NAME, roomChanges: versioned.source, roomChangeFullPassMs: 10 ** 9, journal });
    versioned.mark(roomRef.roomId);
    await store.sync(harness.context, { timeout: 0 });
    const before = await journal.getReconcileCheckpoint(harness.context.podUrl, directory);
    expect(before?.view).toBeDefined();
    expect(before?.lastSourceIri).toContain('rb-0499');

    // Abort the next page: a trigger on a second reference rolls the whole page back.
    database.exec(`
      CREATE TRIGGER abort_rollback BEFORE INSERT ON xpod_matrix_event_refs
      WHEN NEW.message_iri LIKE '%#rb-0500'
      BEGIN SELECT RAISE(ABORT, 'boom'); END
    `);
    await expect(store.sync(harness.context, { timeout: 0 })).rejects.toThrow();
    const after = await journal.getReconcileCheckpoint(harness.context.podUrl, directory);
    expect(after?.view).toBe(before?.view);
    expect(after?.lastSourceIri).toBe(before?.lastSourceIri);
    expect(after?.revision).toBe(before?.revision);
  });

  it('bounds a cycle at its captured upper keyset so a post-bound append lands in the next cycle', async () => {
    const roomRef = { roomId: '' };
    const versioned = versionedSource(roomRef);
    const { store, context, rows } = matrixHarness({ roomChanges: versioned.source, roomChangeFullPassMs: 10 ** 9 });
    roomRef.roomId = (await store.createRoom({}, context)).roomId;
    await store.sendEvent(roomRef.roomId, 'm.room.message', 'template', { body: 'template' }, context);
    const exemplar = rows.get(messageResource)!.find(row => row.role === 'user');
    for (let index = 0; index < 600; index += 1) pushNative(rows, exemplar, `b-${String(index).padStart(4, '0')}`, 500_000 + index, `b ${index}`);
    const directory = roomDirectoryIri(context.podUrl, roomRef.roomId);
    versioned.mark(roomRef.roomId);
    await store.sync(context, { timeout: 0 });
    const bound = await (store as any).journal.getReconcileCheckpoint(context.podUrl, directory);
    // The bound view carries a fixed upper keyset (a real source time), never Date.now.
    const view = JSON.parse(bound.view) as { upper: { createdAt: number; sourceIri: string } | null };
    expect(view.upper).not.toBeNull();
    expect(Number.isFinite(view.upper!.createdAt)).toBe(true);
    expect(view.upper!.sourceIri).toContain('#');

    // A row appended ABOVE the bound is not part of the finished cycle; it is discovered by the
    // rotated next cycle. The bound keeps a cycle finite even while rows keep arriving.
    const aboveUpper = view.upper!.createdAt + 1_000_000;
    pushNative(rows, exemplar, 'post-bound', aboveUpper, 'post bound');
    versioned.mark(roomRef.roomId);
    await versioned.source.pending({ scope: context.podUrl });
    // Finish the current cycle (bounded at the captured upper, so post-bound is excluded).
    await store.sync(context, { timeout: 0 });
    // Drive the fresh generation (which must walk from the beginning) until it reaches post-bound.
    let delivered = false;
    for (let attempt = 0; attempt < 5 && !delivered; attempt += 1) {
      versioned.mark(roomRef.roomId);
      await versioned.source.pending({ scope: context.podUrl });
      await store.sync(context, { timeout: 0 });
      const references = await (store as any).journal.listReferences(context.podUrl, { roomId: roomRef.roomId, limit: 8192 });
      delivered = references.some((reference: { messageIri?: string }) => (reference.messageIri ?? '').endsWith('#post-bound'));
    }
    expect(delivered).toBe(true);
  });
});
