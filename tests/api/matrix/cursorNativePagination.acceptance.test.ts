import { messageResource } from '@undefineds.co/models';
import { describe, expect, it } from 'vitest';
import type { MatrixRoomChangeSource } from '../../../src/api/matrix/PodMatrixStore';
import { MatrixRoomChangeTracker } from '../../../src/api/matrix/notifications/roomChangeTracker';
import { roomDirectoryIri } from '../../../src/api/matrix/roomResources';
import { matrixHarness } from '../../helpers/MatrixMemoryDatabase';

describe('native source pagination, independent acceptance', () => {
  it('finishes a fixed source cycle without a notification source while later rows keep arriving', async() => {
    const { store, context, rows } = matrixHarness();
    const roomId = (await store.createRoom({}, context)).roomId;
    await store.sendEvent(roomId, 'm.room.message', 'finite-template', { body: 'template' }, context);
    let token = (await store.sync(context, { limit: 1_000 })).next_batch;
    const exemplar = rows.get(messageResource)!.find(row => row.role === 'user');
    const append = (id: string, createdAt: string): void => {
      rows.get(messageResource)!.push({ ...exemplar,
        id: messageResource.buildId({ id, parent: exemplar.parent, createdAt }),
        content: id, metadata: {}, createdAt,
      });
    };
    for (let index = 0; index < 600; index++) append(`finite-${index}`, '2000-01-01T00:00:00.000Z');
    token = (await store.sync(context, { since: token, limit: 1_000 })).next_batch;
    const journal = (store as any).journal;
    const directory = roomDirectoryIri(context.podUrl, roomId);
    const partial = await journal.getReconcileCheckpoint(context.podUrl, directory);
    for (let index = 0; index < 500; index++) append(`post-bound-${index}`, '2030-01-01T00:00:00.000Z');
    await store.sync(context, { since: token, limit: 1_000 });
    const completed = await journal.getReconcileCheckpoint(context.podUrl, directory);
    expect(completed.scanGeneration, 'later appends must not extend an unfinished cycle').toBeGreaterThan(partial.scanGeneration);
    const references = await journal.listReferences(context.podUrl, { roomId, limit: 2_000 });
    expect(references.filter((reference: { createdAt: number }) => reference.createdAt === Date.parse('2030-01-01T00:00:00.000Z'))).toHaveLength(0);
  });

  it('keeps an empty captured upper bound empty when a row is appended after the boundary read', async() => {
    const { store, context, rows, db } = matrixHarness();
    const roomId = (await store.createRoom({}, context)).roomId;
    const exemplar = { ...rows.get(messageResource)![0] };
    rows.get(messageResource)!.length = 0;
    const journal = (store as any).journal;
    const before = await journal.listReferences(context.podUrl, { roomId, limit: 100 });
    let injected = false;
    const select = db.select.bind(db);
    db.select = (...args: unknown[]) => {
      const query = select(...args);
      let requested = 0;
      const limit = query.limit.bind(query), then = query.then.bind(query);
      query.limit = (count: number) => { requested = count; return limit(count); };
      query.then = (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) => then((value: unknown) => {
        if (requested === 1 && !injected) {
          injected = true;
          const createdAt = '2000-01-01T00:00:00.000Z';
          rows.get(messageResource)!.push({ ...exemplar,
            id: messageResource.buildId({ id: 'after-empty-boundary', parent: exemplar.parent, createdAt }),
            content: 'after-empty-boundary', metadata: {}, createdAt,
          });
        }
        return resolve(value);
      }, reject);
      return query;
    };
    const first = await (store as any).discoverRoomReferences(db, context, roomId, 'empty-observation');
    expect(first.completed).toBe(true);
    expect(injected).toBe(true);
    expect(await journal.listReferences(context.podUrl, { roomId, limit: 100 })).toEqual(before);
    await (store as any).discoverRoomReferences(db, context, roomId, 'next-observation');
    expect(await journal.listReferences(context.podUrl, { roomId, limit: 100 })).toHaveLength(before.length + 1);
  });

  it.each(['last', 'room', 'bucket'])('does not acknowledge a fresh observation for a legacy %s cursor without a view', async marker => {
    const { store, context, db } = matrixHarness();
    const roomId = (await store.createRoom({}, context)).roomId;
    const journal = (store as any).journal;
    const sourceUri = roomDirectoryIri(context.podUrl, roomId);
    const checkpoint = await journal.beginReconcileScan(context.podUrl, { sourceUri });
    const next = marker === 'last'
      ? { last: { createdAt: Date.parse('2030-01-01T00:00:00.000Z'), sourceIri: `${sourceUri}2030/01/01/messages.ttl#z` } }
      : marker === 'room' ? { roomId } : { bucket: '2026/10/03' };
    await journal.publishReferencePage(context.podUrl, { sourceUri, epoch: checkpoint.epoch,
      scanGeneration: checkpoint.scanGeneration, revision: checkpoint.revision, references: [], next, complete: false });
    const result = await (store as any).discoverRoomReferences(db, context, roomId, 'fresh-observation');
    expect(result.completed).toBe(true);
    expect(result.observation).toBeUndefined();
  });

  it('retains a newer tracker observation when an older source cycle finishes', async() => {
    let tracker: MatrixRoomChangeTracker;
    const source: MatrixRoomChangeSource = {
      pending: input => tracker.pending(input),
      settle: input => tracker.settle(input),
    };
    const { store, context, rows } = matrixHarness({ roomChanges: source });
    tracker = new MatrixRoomChangeTracker({ scope: context.podUrl, endpoint: `${context.podUrl}.notifications/`,
      rooms: async() => [], fetch: async() => { throw new Error('This test must not use HTTP'); },
      openSocket: () => { throw new Error('This test must not open sockets'); },
    });
    // Isolate the real tracker's observation/settlement logic from channel transport.
    Object.assign(tracker, { stopped: false, trust: 'changed' });
    const roomId = (await store.createRoom({}, context)).roomId;
    await store.sendEvent(roomId, 'm.room.message', 'observation-template', { body: 'template' }, context);
    let token = (await store.sync(context, { limit: 1_000 })).next_batch;
    const exemplar = rows.get(messageResource)!.find(row => row.role === 'user');
    const append = (id: string, createdAt: string): void => {
      rows.get(messageResource)!.push({ ...exemplar,
        id: messageResource.buildId({ id, parent: exemplar.parent, createdAt }),
        content: id, metadata: {}, createdAt,
      });
    };
    for (let index = 0; index < 600; index++) {
      append(`cycle-${String(index).padStart(3, '0')}`, '2000-01-01T00:00:00.000Z');
    }
    (tracker as any).markRoom(roomId);
    token = (await store.sync(context, { since: token, limit: 1_000 })).next_batch;
    expect((await tracker.pending({ scope: context.podUrl })).rooms).toContain(roomId);
    append('earlier-between-pages', '1990-01-01T00:00:00.000Z');
    (tracker as any).markRoom(roomId);
    token = (await store.sync(context, { since: token, limit: 1_000 })).next_batch;
    expect((await tracker.pending({ scope: context.podUrl })).rooms,
      'an old cycle must not acknowledge the newer observation').toContain(roomId);
    const delivered: string[] = [];
    for (let poll = 0; poll < 4; poll++) {
      const page = await store.sync(context, { since: token, limit: 1_000 });
      delivered.push(...(page.rooms.join[roomId]?.timeline.events ?? []).map(event => String(event.content.body)));
      token = page.next_batch;
    }
    expect(delivered.filter(body => body === 'earlier-between-pages')).toHaveLength(1);
  });
  it('rejects an oversized backend page without publishing or settling it', async() => {
    let dirty = false;
    let roomId = '';
    const source: MatrixRoomChangeSource = {
      pending: async() => ({ trust: 'changed', rooms: dirty ? [roomId] : [], snapshot: {} }),
      settle: async({ rooms }) => { if (rooms.includes(roomId)) dirty = false; },
    };
    const { store, context, rows, db } = matrixHarness({ roomChanges: source });
    roomId = (await store.createRoom({}, context)).roomId;
    await store.sendEvent(roomId, 'm.room.message', 'oversized-template', { body: 'template' }, context);
    const token = (await store.sync(context, { limit: 1_000 })).next_batch;
    const journal = (store as any).journal;
    const before = await journal.getPublishedReferenceWatermark(context.podUrl);
    const exemplar = rows.get(messageResource)!.find(row => row.role === 'user');
    const createdAt = '2000-01-01T00:00:00.000Z';
    for (let index = 0; index < 501; index++) rows.get(messageResource)!.push({ ...exemplar,
      id: messageResource.buildId({ id: `oversized-${index}`, parent: exemplar.parent, createdAt }),
      metadata: {}, createdAt,
    });
    const select = db.select.bind(db);
    db.select = (...args: unknown[]) => {
      const query = select(...args);
      const limit = query.limit.bind(query);
      // Simulate a backend that fails to enforce the requested bound.
      query.limit = (count: number) => limit(count + 1);
      return query;
    };
    dirty = true;
    await expect(store.sync(context, { since: token })).rejects.toMatchObject({ status: 503 });
    expect(await journal.getPublishedReferenceWatermark(context.podUrl)).toBe(before);
    expect(dirty).toBe(true);
  });
  it('validates the whole source page before publishing a valid prefix or settling its hint', async() => {
    let dirty = false;
    let roomId = '';
    const source: MatrixRoomChangeSource = {
      pending: async() => ({ trust: 'changed', rooms: dirty ? [roomId] : [], snapshot: {} }),
      settle: async({ rooms }) => { if (rooms.includes(roomId)) dirty = false; },
    };
    const { store, context, rows } = matrixHarness({ roomChanges: source });
    roomId = (await store.createRoom({}, context)).roomId;
    await store.sendEvent(roomId, 'm.room.message', 'validation-template', { body: 'template' }, context);
    const token = (await store.sync(context, { limit: 1_000 })).next_batch;
    const journal = (store as any).journal;
    const before = await journal.getPublishedReferenceWatermark(context.podUrl);
    const exemplar = rows.get(messageResource)!.find(row => row.role === 'user');
    const createdAt = '2000-01-01T00:00:00.000Z';
    rows.get(messageResource)!.push({ ...exemplar,
      id: messageResource.buildId({ id: 'validation-A', parent: exemplar.parent, createdAt }),
      content: 'valid prefix', metadata: {}, createdAt,
    }, { ...exemplar,
      id: messageResource.buildId({ id: 'validation-B', parent: exemplar.parent, createdAt }),
      // The copied protocol timestamp contradicts this row's RDF timestamp.
      createdAt,
    });
    dirty = true;
    await expect(store.sync(context, { since: token })).rejects.toMatchObject({ status: 503 });
    expect(await journal.getPublishedReferenceWatermark(context.podUrl)).toBe(before);
    expect(dirty).toBe(true);
  });
  it('runs a due pull even when known API references keep arriving without notifications', async() => {
    const { store, context, rows } = matrixHarness({ roomChangeFullPassMs: 0 });
    const roomId = (await store.createRoom({}, context)).roomId;
    await store.sendEvent(roomId, 'm.room.message', 'due-template', { body: 'template' }, context);
    const token = (await store.sync(context, { limit: 1_000 })).next_batch;
    await store.sendEvent(roomId, 'm.room.message', 'due-known-reference', { body: 'API while due' }, context);
    const exemplar = rows.get(messageResource)!.find(row => row.role === 'user');
    const createdAt = '2000-01-01T00:00:00.000Z';
    rows.get(messageResource)!.push({ ...exemplar,
      id: messageResource.buildId({ id: 'due-native', parent: exemplar.parent, createdAt }),
      content: 'native while due', metadata: {}, createdAt,
    });
    const response = await store.sync(context, { since: token, limit: 1_000 });
    expect(response.rooms.join[roomId]?.timeline.events.map(event => String(event.content.body)).sort())
      .toEqual(['API while due', 'native while due']);
  });

  it('publishes native rows before taking the initial response watermark', async() => {
    const { store, context, rows } = matrixHarness();
    const roomId = (await store.createRoom({}, context)).roomId;
    await store.sendEvent(roomId, 'm.room.message', 'initial-template', { body: 'template' }, context);
    const exemplar = rows.get(messageResource)!.find(row => row.role === 'user');
    const createdAt = '2000-01-01T00:00:00.000Z';
    rows.get(messageResource)!.push({ ...exemplar,
      id: messageResource.buildId({ id: 'before-initial-sync', parent: exemplar.parent, createdAt }),
      content: 'native before initial sync', metadata: {}, createdAt,
    });
    const response = await store.sync(context, { limit: 1_000 });
    expect(response.rooms.join[roomId]?.timeline.events.some(event => event.content.body === 'native before initial sync'))
      .toBe(true);
    const references = await (store as any).journal.listReferences(context.podUrl, { roomId, limit: 1_000 });
    expect(references.some((reference: { createdAt: number }) => reference.createdAt === Date.parse(createdAt))).toBe(true);
  });

  it('does not acknowledge unknown-source reconciliation merely because an API reference is available', async() => {
    let unknown = false;
    const source: MatrixRoomChangeSource = {
      pending: async() => ({ trust: unknown ? 'all' : 'changed', rooms: [], snapshot: {} }),
      settle: async({ full }) => { if (full) unknown = false; },
    };
    const { store, context, rows } = matrixHarness({ roomChanges: source });
    const roomId = (await store.createRoom({}, context)).roomId;
    await store.sendEvent(roomId, 'm.room.message', 'template', { body: 'template' }, context);
    let token = (await store.sync(context, { limit: 1_000 })).next_batch;
    await store.sendEvent(roomId, 'm.room.message', 'known-reference', { body: 'API news' }, context);
    const exemplar = rows.get(messageResource)!.find(row => row.role === 'user');
    const createdAt = '2000-01-01T00:00:00.000Z';
    rows.get(messageResource)!.push({ ...exemplar,
      id: messageResource.buildId({ id: 'unknown-source-native', parent: exemplar.parent, createdAt }),
      content: 'unknown-source native', metadata: {}, createdAt,
    });
    unknown = true;
    const observed: string[] = [];
    for (let poll = 0; poll < 4 && observed.length < 2; poll++) {
      const response = await store.sync(context, { since: token, limit: 1 });
      observed.push(...(response.rooms.join[roomId]?.timeline.events ?? []).map(event => String(event.content.body)));
      token = response.next_batch;
      if (!unknown) {
        const references = await (store as any).journal.listReferences(context.podUrl, { roomId, limit: 1_000 });
        expect(references.some((reference: { createdAt: number }) => reference.createdAt === Date.parse(createdAt)),
          'full settlement requires native source publication, even with known API backlog').toBe(true);
      }
    }
    expect([...observed].sort()).toEqual(['API news', 'unknown-source native']);
    expect(unknown).toBe(false);
  });

  it('continues past a full source page without losing its notification or tied resources', async() => {
    let roomId = '';
    let dirty = false;
    const source: MatrixRoomChangeSource = {
      pending: async() => ({ trust: 'changed', rooms: dirty ? [roomId] : [], snapshot: 'native-page-observation' }),
      settle: async({ rooms }) => { if (rooms.includes(roomId)) dirty = false; },
    };
    const { store, context, rows, db } = matrixHarness({ roomChanges: source });
    roomId = (await store.createRoom({}, context)).roomId;
    await store.sendEvent(roomId, 'm.room.message', 'native-template', { body: 'template' }, context);
    let token = (await store.sync(context, { limit: 1_000 })).next_batch;
    const exemplar = rows.get(messageResource)!.find(row => row.role === 'user');
    const createdAt = '2000-01-01T00:00:00.000Z';
    const expected = Array.from({ length: 600 }, (_, index) => `native-page-${String(index).padStart(3, '0')}`);
    // All rows arrive outside the API journal, with an old timestamp and one broad notification.
    for (const body of [...expected].reverse()) {
      rows.get(messageResource)!.push({ ...exemplar,
        id: messageResource.buildId({ id: body, parent: exemplar.parent, createdAt }),
        content: body, metadata: {}, createdAt,
      });
    }
    dirty = true;
    const sourcePageLengths: number[] = [];
    const select = db.select.bind(db);
    db.select = (...args: unknown[]) => {
      const query = select(...args);
      const then = query.then.bind(query);
      query.then = (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) => then(
        (value: unknown) => {
          if (Array.isArray(value)) sourcePageLengths.push(value.length);
          return resolve(value);
        }, reject,
      );
      return query;
    };
    const observed: string[] = [];
    for (let poll = 0; poll < 10 && observed.length < expected.length; poll++) {
      const response = await store.sync(context, { since: token, limit: 100 });
      expect(sourcePageLengths.every(length => length <= 500),
        'source cursor pages must stay bounded; growing LIMIT and reopening the prefix is not pagination').toBe(true);
      const events = response.rooms.join[roomId]?.timeline.events ?? [];
      expect(events.length).toBeLessThanOrEqual(100);
      observed.push(...events.map(event => String(event.content.body)));
      token = response.next_batch;
      expect(token.length).toBeLessThanOrEqual(128);
      // Delivery can lag discovery, but a broad hint cannot be forgotten while unpublished rows remain.
      if (!dirty) {
        const references = await (store as any).journal.listReferences(context.podUrl, { roomId, limit: 1_000 });
        expect(references.filter((reference: { createdAt: number }) => reference.createdAt === Date.parse(createdAt)))
          .toHaveLength(expected.length);
      }
    }
    expect([...observed].sort()).toEqual(expected);
    expect(new Set(observed).size).toBe(expected.length);
    expect(dirty).toBe(false);
  });
});
