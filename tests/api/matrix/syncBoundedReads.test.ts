import { describe, expect, it, vi } from 'vitest';
import { messageResource } from '@undefineds.co/models';
import { matrixHarness } from '../../helpers/MatrixMemoryDatabase';
import { getProtocolMetadata, withProtocolMetadata } from '../../../src/api/protocol-metadata';

/** A room with a couple of messages, and the token that says "I have seen them". */
async function roomWithMessages() {
  const harness = matrixHarness();
  const { store, context } = harness;
  const room = await store.createRoom({}, context);
  await store.sendEvent(room.roomId, 'm.room.message', 'txn-1', { body: 'one' }, context);
  await store.sendEvent(room.roomId, 'm.room.message', 'txn-2', { body: 'two' }, context);
  const seen = await store.sync(context);
  return { ...harness, room, token: seen.next_batch };
}

describe('bounded sync reads', () => {
  it('does not re-read every room while waiting, once nothing has changed', async () => {
    const { store, context, db, room, token } = await roomWithMessages();
    const select = vi.spyOn(db, 'select');
    const started = Date.now();
    const idle = await store.sync(context, { since: token, timeout: 1_200 });
    const elapsed = Date.now() - started;

    // Nothing new: no room is reported, and the wait was actually waited.
    expect(idle.rooms.join[room.roomId]).toBeUndefined();
    expect(idle.next_batch).toBe(token);
    expect(elapsed).toBeGreaterThanOrEqual(1_000);
    // The two indexing/reading passes still run (see below), but the wait loop does not
    // touch the Pod again: an unchanged scope watermark means no room can have anything new.
    expect(select.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it('reports what arrived after the token, even while a client is waiting', async () => {
    const { store, context, room, token } = await roomWithMessages();
    await store.sendEvent(room.roomId, 'm.room.message', 'txn-3', { body: 'three' }, context);

    const sync = await store.sync(context, { since: token, timeout: 0 });
    expect(sync.rooms.join[room.roomId].timeline.events.map(event => event.content.body)).toEqual([ 'three' ]);
    expect(sync.next_batch).not.toBe(token);
  });

  it('still indexes a row written straight into the Pod', async () => {
    const { store, context, db, rows, room, token } = await roomWithMessages();
    // Simulate a native write: a message row appears in the Pod without going through the
    // store, so the journal has never seen it and the scope watermark has not moved.
    const template = rows.get(messageResource as never)![0];
    const nativeEventId = '$native-event';
    const native = structuredClone(template);
    native.id = `${template.id}-native`;
    native.createdAt = new Date(Date.now() + 1_000).toISOString();
    native.content = 'native write';
    const matrix = getProtocolMetadata(native.metadata, 'matrix')!;
    native.metadata = withProtocolMetadata(native.metadata, 'matrix', {
      ...matrix,
      event: { ...(matrix.event as Record<string, unknown>), event_id: nativeEventId, content: { body: 'native write' } },
    });
    await db.insert(messageResource).values(native);

    const sync = await store.sync(context, { since: token, timeout: 0 });
    // The indexing pass is what makes this visible; short-circuiting it would hide the row
    // until something else advanced the watermark.
    expect(sync.rooms.join[room.roomId].timeline.events.map(event => event.event_id)).toContain(nativeEventId);
  });

  it('reads the timeline once for a page of messages', async () => {
    const { store, context, db, room } = await roomWithMessages();
    const select = vi.spyOn(db, 'select');
    const page = await store.listMessages(room.roomId, context, { limit: 2 });

    // Membership costs one read and the page costs one; the old code read the whole
    // timeline a second time and threw the result away.
    expect(select.mock.calls.length).toBe(2);
    expect(page.chunk.map(event => event.content.body)).toEqual([ 'two', 'one' ]);
  });

  it('pages backwards through the timeline without losing the boundary', async () => {
    const { store, context, room } = await roomWithMessages();
    const first = await store.listMessages(room.roomId, context, { limit: 1 });
    expect(first.chunk.map(event => event.content.body)).toEqual([ 'two' ]);
    const second = await store.listMessages(room.roomId, context, { limit: 1, from: first.end });
    expect(second.chunk.map(event => event.content.body)).toEqual([ 'one' ]);
    expect(second.end).not.toBe(first.end);
  });
});
