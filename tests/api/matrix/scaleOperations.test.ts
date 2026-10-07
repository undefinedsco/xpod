import { describe, expect, it, vi } from 'vitest';
import { matrixHarness } from '../../helpers/MatrixMemoryDatabase';

/**
 * How many Pod operations an operation costs, at scale.
 *
 * The acceptance gate is about work being *bounded*, and the honest unit for that here is the
 * number of Pod round trips (`db.select` / `db.insert`), not CPU time: a Pod read is a network
 * round trip with its own authorisation, so what matters is how the count grows with the
 * number of rooms. Every number below is measured, not assumed, and the counts that are
 * expected to grow are asserted to grow *only* in the term that has to.
 */

interface Counters {
  selects: number;
  /** One fixed upper-keyset read per source reconciliation cycle. */
  boundaries: number;
  inserts: number;
  /** Rows the reads returned: a Pod read costs what it reads, not what it returns. */
  rows: number;
}

function counting(db: any) {
  const counters: Counters = { selects: 0, boundaries: 0, inserts: 0, rows: 0 };
  const select = db.select.bind(db);
  const insert = db.insert.bind(db);
  db.select = (...args: unknown[]) => {
    counters.selects += 1;
    const query = select(...args);
    const limit = query.limit.bind(query);
    query.limit = (size: number) => {
      if (size === 1) { counters.boundaries += 1; }
      return limit(size);
    };
    const then = query.then.bind(query);
    query.then = (ok: (rows: unknown) => unknown, fail: (error: unknown) => unknown) => then(
      (rows: unknown) => { counters.rows += Array.isArray(rows) ? rows.length : 0; return ok(rows); },
      fail,
    );
    return query;
  };
  db.insert = (...args: unknown[]) => { counters.inserts += 1; return insert(...args); };
  return {
    counters,
    async measure<T>(work: () => Promise<T>): Promise<{ result: T; ops: Counters }> {
      counters.selects = 0;
      counters.boundaries = 0;
      counters.inserts = 0;
      counters.rows = 0;
      const result = await work();
      return { result, ops: { ...counters } };
    },
  };
}

/** A deployment with `rooms` rooms of `messages` messages each. */
async function atScale(rooms: number, messages: number) {
  const harness = matrixHarness();
  const { store, context } = harness;
  const roomIds: string[] = [];
  for (let room = 0; room < rooms; room += 1) {
    const created = await store.createRoom({ name: `room-${room}` }, context);
    roomIds.push(created.roomId);
    for (let message = 0; message < messages; message += 1) {
      await store.sendEvent(created.roomId, 'm.room.message', `txn-${room}-${message}`, { body: `${room}:${message}` }, context);
    }
  }
  return { ...harness, store, context, roomIds };
}

describe('Pod work at scale', () => {
  it('costs a write, a state read and a page the same in a small and a large deployment', async () => {
    const small = await atScale(10, 2);
    const large = await atScale(200, 2);
    const smallCount = counting(small.db);
    const largeCount = counting(large.db);

    const measure = async (scale: Awaited<ReturnType<typeof atScale>>, counters: ReturnType<typeof counting>) => {
      const room = scale.roomIds[scale.roomIds.length - 1];
      const write = await counters.measure(async () => await scale.store.sendEvent(room, 'm.room.message', 'txn-measured', { body: 'x' }, scale.context));
      const state = await counters.measure(async () => await scale.store.currentState(room, scale.context));
      const page = await counters.measure(async () => await scale.store.listMessages(room, scale.context, { limit: 5 }));
      expect(write.result.eventId).toBeTruthy();
      expect(state.result.size).toBeGreaterThan(0);
      expect(page.result.chunk).toHaveLength(5);
      return { write: write.ops, state: state.ops, page: page.ops };
    };

    const smallOps = await measure(small, smallCount);
    const largeOps = await measure(large, largeCount);

    // A write, a state read and a page touch their own room, so 10 rooms and 200 rooms cost
    // exactly the same. This is the property the gate asks for.
    expect(largeOps.write).toEqual(smallOps.write);
    expect(largeOps.state).toEqual(smallOps.state);
    expect(largeOps.page).toEqual(smallOps.page);
    // And it is a small constant, not "whatever the room happens to hold".
    expect(smallOps.write.selects).toBeLessThanOrEqual(4);
    expect(smallOps.state.selects).toBeLessThanOrEqual(3);
    expect(smallOps.page.selects).toBeLessThanOrEqual(3);
    // Measured: 1 select + 1 insert for a write, 1 select for a state read, 2 selects and
    // 12 rows for a five-message page — the same in a 10-room and a 200-room Pod, and the
    // rows are that room's own events however many rooms the Pod holds.
    expect(smallOps.page.rows).toBeLessThanOrEqual(16);
    // Nothing here is quadratic in the room's history either: the page limit bounds the work.
  });

  for (const rooms of [ 10, 200, 1_000 ]) {
    it(`reads only the selected room for a cursor increment among ${rooms} rooms`, async () => {
      const scale = await atScale(rooms, 2);
      const room = scale.roomIds[0];
      let initial = await scale.store.sync(scale.context, { limit: 1_000 });
      let bootstrapPages = 0;
      while (Object.values(initial.rooms.join).some(joined => joined.timeline.events.length > 0)) {
        expect(bootstrapPages++, 'bootstrap must finish before incremental work is measured').toBeLessThan(10);
        initial = await scale.store.sync(scale.context, { since: initial.next_batch, limit: 1_000 });
      }
      const written = await scale.store.sendEvent(room, 'm.room.message', 'txn-new', { body: 'new' }, scale.context);
      const counters = counting(scale.db);
      const history = vi.spyOn(scale.store as any, 'listEvents');
      const exact = vi.spyOn(scale.db, 'findByIri');
      const incremental = await counters.measure(async () => await scale.store.sync(scale.context, {
        since: initial.next_batch, timeout: 0,
      }));
      expect(Object.keys(incremental.result.rooms.join)).toEqual([ room ]);
      expect(incremental.result.rooms.join[room].timeline.events.map(event => event.event_id)).toEqual([ written.eventId ]);
      expect(incremental.result.rooms.join[room].timeline.events.map(event => event.content.body)).toEqual([ 'new' ]);
      expect(history, 'normal published increments must not reopen any room history').not.toHaveBeenCalled();
      expect(incremental.ops.selects).toBe(0);
      expect(exact.mock.calls, 'one authority read and one selected event read').toHaveLength(2);
      history.mockRestore();
      exact.mockRestore();
    });
  }

  it('keeps the idle wait loop from re-reading rooms, whatever the deployment size', async () => {
    const scale = await atScale(20, 2);
    const counters = counting(scale.db);
    const first = await scale.store.sync(scale.context, { limit: 1_000 });
    const history = vi.spyOn(scale.store as any, 'listEvents');

    const idle = await counters.measure(async () => await scale.store.sync(scale.context, { since: first.next_batch, timeout: 1_000 }));
    expect(idle.result.rooms.join).toEqual({});
    // One fixed-upper metadata read and one source page per room, then no further wait-loop reads.
    expect(idle.ops.boundaries).toBe(scale.roomIds.length);
    expect(idle.ops.selects - idle.ops.boundaries).toBeLessThanOrEqual(scale.roomIds.length + 1);
    expect(history).not.toHaveBeenCalled();
    history.mockRestore();
  });
});

describe('memory at scale', () => {
  it('holds a thousand rooms without growing without bound', async () => {
    const before = process.memoryUsage().heapUsed;
    const scale = await atScale(1_000, 1);
    const after = process.memoryUsage().heapUsed;
    // Measured: 9.6 MB for 1000 rooms and 2000 events in this harness.
    const deltaMb = (after - before) / (1024 * 1024);

    // 1000 rooms and 2000 events: the Pod rows themselves dominate, and the store must not
    // multiply them (no per-room replay kept for every room).
    expect(scale.roomIds).toHaveLength(1_000);
    expect(deltaMb).toBeLessThan(500);
    // A read of one room in that deployment still costs the same as in a tiny one.
    const counters = counting(scale.db);
    const measured = await counters.measure(async () => await scale.store.listMessages(scale.roomIds[0], scale.context, { limit: 3 }));
    // One message plus the create and member events that make the room's timeline.
    expect(measured.result.chunk).toHaveLength(3);
    expect(measured.ops.selects).toBeLessThanOrEqual(3);
    expect(measured.ops.rows).toBeLessThanOrEqual(16);
  });
});
