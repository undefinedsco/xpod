import { describe, expect, it, vi } from 'vitest';
import { messageResource } from '@undefineds.co/models';
import { matrixHarness } from '../../helpers/MatrixMemoryDatabase';
import type { MatrixRoomChangeSource } from '../../../src/api/matrix/PodMatrixStore';
import { roomChatIri, roomDirectoryIri } from '../../../src/api/matrix/roomResources';

/**
 * A change source the test drives, standing in for a notification subscription.
 *
 * It keeps reporting what it was told until `settle` is called, which is what stops a change
 * that arrives while a pass runs from being forgotten.
 */
function changeSource() {
  let pending: { trust: 'all' | 'changed'; rooms: string[] } = { trust: 'all', rooms: [] };
  const settled: string[][] = [];
  const source: MatrixRoomChangeSource = {
    pending: async () => ({ trust: pending.trust, rooms: [ ...pending.rooms ] }),
    settle: async ({ rooms }) => { settled.push([ ...rooms ]); },
  };
  return {
    source,
    settled,
    says(rooms: string[], trust: 'all' | 'changed' = 'changed') { pending = { trust, rooms }; },
  };
}

function counting(db: any) {
  let selects = 0;
  let boundaries = 0;
  const select = db.select.bind(db);
  db.select = (...args: unknown[]) => {
    selects += 1;
    const query = select(...args);
    const limit = query.limit.bind(query);
    query.limit = (size: number) => {
      // These fixtures have exactly one LIMIT 1 query: the fixed source upper keyset.
      if (size === 1) { boundaries += 1; }
      return limit(size);
    };
    return query;
  };
  return {
    selects: () => selects,
    boundaries: () => boundaries,
    sourceAndStateReads: () => selects - boundaries,
  };
}

/** A deployment of `rooms` rooms, each with a message, and a caught-up sync token. */
async function caughtUp(rooms: number, options: { roomChanges?: MatrixRoomChangeSource; roomChangeFullPassMs?: number } = {}) {
  const harness = matrixHarness(options);
  const { store, context } = harness;
  const roomIds: string[] = [];
  for (let room = 0; room < rooms; room += 1) {
    const created = await store.createRoom({ name: `room-${room}` }, context);
    roomIds.push(created.roomId);
    await store.sendEvent(created.roomId, 'm.room.message', `txn-${room}`, { body: `${room}` }, context);
  }
  const first = await store.sync(context, { limit: 1_000 });
  return { ...harness, roomIds, token: first.next_batch };
}

function appendNativeRows(scale: Awaited<ReturnType<typeof caughtUp>>, label: string): void {
  const createdAt = '2000-01-01T00:00:00.000Z';
  for (const roomId of scale.roomIds) {
    const parent = roomChatIri(scale.context.podUrl, roomId);
    const exemplar = scale.rows.get(messageResource)!.find(row => row.parent === parent && row.role === 'user');
    scale.rows.get(messageResource)!.push({ ...exemplar, parent, metadata: {}, createdAt,
      id: messageResource.buildId({ id: `${label}-${roomId}`, parent, createdAt }), content: label });
  }
}

describe('sync with a change source', () => {
  it('reads no room at all when the source says nothing changed', async () => {
    const changes = changeSource();
    const scale = await caughtUp(20, { roomChanges: changes.source });
    const counter = counting(scale.db);
    changes.says([]);

    const sync = await scale.store.sync(scale.context, { since: scale.token, timeout: 0 });
    // This is the bound the measurement was missing: an idle caught-up sync costs no Pod read.
    expect(counter.selects()).toBe(0);
    expect(sync.rooms.join).toEqual({});
    expect(sync.next_batch).toBe(scale.token);
  });

  it('reads only the room the source names', async () => {
    const changes = changeSource();
    const scale = await caughtUp(20, { roomChanges: changes.source });
    const [ changed, other ] = scale.roomIds;
    await scale.store.sendEvent(changed, 'm.room.message', 'txn-new', { body: 'new' }, scale.context);
    const counter = counting(scale.db);
    const exactReads = vi.spyOn(scale.db, 'findByIri');
    const history = vi.spyOn(scale.store as any, 'listEvents');
    changes.says([ changed ]);

    const sync = await scale.store.sync(scale.context, { since: scale.token, timeout: 0 });
    // A published reference needs bounded point reads, irrespective of the other nineteen rooms.
    expect(counter.selects()).toBeLessThanOrEqual(2);
    expect(history).not.toHaveBeenCalled();
    expect(exactReads.mock.calls.length).toBeGreaterThan(0);
    expect(exactReads.mock.calls.length).toBeLessThanOrEqual(4);
    const directory = roomDirectoryIri(scale.context.podUrl, changed);
    expect(exactReads.mock.calls.every(([, iri]) => String(iri).startsWith(directory))).toBe(true);
    expect(Object.keys(sync.rooms.join)).toEqual([ changed ]);
    expect(sync.rooms.join[changed].timeline.events.map(event => event.content.body)).toEqual([ 'new' ]);
    expect(sync.rooms.join[other]).toBeUndefined();
    // The source may forget what was read, and only what was read.
    expect(changes.settled.at(-1)).toEqual([ changed ]);
    exactReads.mockRestore();
    history.mockRestore();
  });

  it('ignores the source for a caller that is behind, and reads every room', async () => {
    const changes = changeSource();
    const scale = await caughtUp(10, { roomChanges: changes.source });
    const counter = counting(scale.db);
    // The caller holds no token at all, so the source's "nothing changed" cannot mean "you
    // already have everything".
    changes.says([]);

    const sync = await scale.store.sync(scale.context, { timeout: 0 });
    // Initial state bootstrap is separate from discovery; normal cursor pages must not repeat it.
    expect(counter.boundaries()).toBe(scale.roomIds.length);
    expect(counter.sourceAndStateReads()).toBeLessThanOrEqual(2 * (scale.roomIds.length + 1));
    expect(Object.keys(sync.rooms.join)).toHaveLength(scale.roomIds.length);
  });

  it('reads every room when the source admits it cannot account for everything', async () => {
    const changes = changeSource();
    const scale = await caughtUp(10, { roomChanges: changes.source });
    appendNativeRows(scale, 'unknown native');
    const counter = counting(scale.db);
    changes.says([], 'all');

    const sync = await scale.store.sync(scale.context, { since: scale.token, timeout: 0 });
    expect(counter.boundaries()).toBe(scale.roomIds.length);
    expect(counter.sourceAndStateReads()).toBeLessThanOrEqual(scale.roomIds.length + 1);
    expect(Object.keys(sync.rooms.join)).toHaveLength(scale.roomIds.length);
    for (const roomId of scale.roomIds) {
      expect(sync.rooms.join[roomId].timeline.events.map(event => event.content.body)).toEqual(['unknown native']);
    }
  });

  it('picks up a change that arrives while the caller waits', async () => {
    const changes = changeSource();
    const scale = await caughtUp(5, { roomChanges: changes.source });
    const [ changed ] = scale.roomIds;
    changes.says([]);

    // The change lands after the sync has already started waiting.
    setTimeout(() => { void scale.store.sendEvent(changed, 'm.room.message', 'txn-late', { body: 'late' }, scale.context).then(() => changes.says([ changed ])); }, 50);
    const sync = await scale.store.sync(scale.context, { since: scale.token, timeout: 2_000 });
    expect(sync.rooms.join[changed].timeline.events.map(event => event.content.body)).toEqual([ 'late' ]);
  });

  it('reads every room again once the safety net is due', async () => {
    const changes = changeSource();
    // A zero safety net means "always due", i.e. the periodic full pass is happening now.
    const scale = await caughtUp(10, { roomChanges: changes.source, roomChangeFullPassMs: 0 });
    appendNativeRows(scale, 'due native');
    const counter = counting(scale.db);
    changes.says([]);

    const sync = await scale.store.sync(scale.context, { since: scale.token, timeout: 0 });
    expect(counter.boundaries()).toBe(scale.roomIds.length);
    expect(counter.sourceAndStateReads()).toBeLessThanOrEqual(scale.roomIds.length + 1);
    expect(Object.keys(sync.rooms.join)).toHaveLength(scale.roomIds.length);
    for (const roomId of scale.roomIds) {
      expect(sync.rooms.join[roomId].timeline.events.map(event => event.content.body)).toEqual(['due native']);
    }
  });
});
