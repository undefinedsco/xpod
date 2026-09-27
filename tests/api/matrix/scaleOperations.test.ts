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
  inserts: number;
  /** Rows the reads returned: a Pod read costs what it reads, not what it returns. */
  rows: number;
}

function counting(db: any) {
  const counters: Counters = { selects: 0, inserts: 0, rows: 0 };
  const select = db.select.bind(db);
  const insert = db.insert.bind(db);
  db.select = (...args: unknown[]) => {
    counters.selects += 1;
    const query = select(...args);
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

  it('reads every room once per sync pass, which is the part that is not bounded', async () => {
    const scale = await atScale(50, 2);
    const counters = counting(scale.db);
    const room = scale.roomIds[0];
    // A limit large enough that the first sync delivers everything, so its token is the
    // scope watermark rather than the depth of a page boundary.
    const first = await counters.measure(async () => await scale.store.sync(scale.context, { limit: 1_000 }));
    expect(first.result.next_batch).toBeTruthy();

    // One new event in one room: the incremental sync still walks every room, because a
    // room's own watermark cannot say whether a row was written straight into the Pod.
    await scale.store.sendEvent(room, 'm.room.message', 'txn-new', { body: 'new' }, scale.context);
    const incremental = await counters.measure(async () => await scale.store.sync(scale.context, { since: first.result.next_batch, timeout: 0 }));
    expect(incremental.result.rooms.join[room].timeline.events).toHaveLength(1);

    // Measured: 102 selects for 50 rooms, i.e. 2 x (rooms + 1) — one room-list read and one
    // timeline read per pass, and nothing per event.
    const rooms = scale.roomIds.length;
    // Two passes (the indexing pass and the reading pass), each reading the room list once and
    // every room's timeline once.
    expect(incremental.ops.selects).toBe(2 * (rooms + 1));
    // Measured: 602 rows read for a change of one event, against 600 for the full sync — the
    // pass costs the Pod's whole history, not the part that changed. This is the term the
    // gate's "bounded work" is about, and bounding it needs a Pod-side index or signal.
    expect(incremental.ops.rows).toBeGreaterThanOrEqual(first.ops.rows);
    expect(incremental.ops.rows).toBeLessThanOrEqual(first.ops.rows + 10);
    // The idle case is the same shape, which is why the wait loop short-circuits instead.
    const idle = await counters.measure(async () => await scale.store.sync(scale.context, { since: incremental.result.next_batch, timeout: 0 }));
    // Nothing new: the timeline is empty. (With `timeout: 0` the response still carries the
    // unchanged state; the empty-rooms short-circuit belongs to the wait loop.)
    expect(idle.result.rooms.join[room].timeline.events).toEqual([]);
    expect(idle.ops.selects).toBe(2 * (rooms + 1));
  });

  it('keeps the idle wait loop from re-reading rooms, whatever the deployment size', async () => {
    const scale = await atScale(20, 2);
    const counters = counting(scale.db);
    const first = await scale.store.sync(scale.context, { limit: 1_000 });

    const idle = await counters.measure(async () => await scale.store.sync(scale.context, { since: first.next_batch, timeout: 1_000 }));
    expect(idle.result.rooms.join).toEqual({});
    // Two indexing/reading passes, and then nothing: the wait loop stops touching the Pod.
    expect(idle.ops.selects).toBe(2 * (scale.roomIds.length + 1));
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
