import { describe, expect, it, vi } from 'vitest';
import { MatrixRoomChangeTracker } from '../../../../src/api/matrix/notifications/roomChangeTracker';
import type { NotificationSocket } from '../../../../src/api/matrix/notifications/roomChangeSubscription';
import { roomDirectoryIri, roomMessagesDocumentIri } from '../../../../src/api/matrix/roomResources';

const SCOPE = 'https://pod.example/alice/';
const ENDPOINT = `${SCOPE}.notifications/WebSocketChannel2023/`;
const ROOM_A = '!a:alice.example';
const ROOM_B = '!b:alice.example';
const DAY = new Date('2026-09-27T10:00:00.000Z');

function fakeSocket() {
  const listeners = new Map<string, ((event: any) => void)[]>();
  const socket: NotificationSocket = {
    send: vi.fn((_data: string) => undefined),
    close: vi.fn(() => { for (const listener of listeners.get('close') ?? []) listener({}); }),
    addEventListener: (event: string, listener: (event: any) => void) => {
      listeners.set(event, [ ...(listeners.get(event) ?? []), listener ]);
    },
  };
  return {
    socket,
    open: () => { for (const listener of listeners.get('open') ?? []) listener({}); },
    emit: (data: unknown) => { for (const listener of listeners.get('message') ?? []) listener({ data }); },
  };
}

function tracker(options: {
  rooms?: readonly string[];
  failTopic?: (topic: string) => boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  autoOpen?: boolean;
} = {}) {
  const sockets = new Map<string, ReturnType<typeof fakeSocket>>();
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { topic?: string };
    if (body.topic && options.failTopic?.(body.topic)) return new Response('', { status: 403 });
    return new Response(JSON.stringify({
      id: `channel-${body.topic}`,
      receiveFrom: `wss://pod.example/.notifications/websocket/${encodeURIComponent(body.topic ?? '')}`,
    }), { status: 201, headers: { 'content-type': 'application/ld+json' } });
  });
  const errors: Error[] = [];
  const instance = new MatrixRoomChangeTracker({
    scope: SCOPE,
    endpoint: ENDPOINT,
    fetch: fetch as unknown as typeof fetch,
    openSocket: url => {
      const created = fakeSocket();
      sockets.set(url, created);
      if (options.autoOpen !== false) queueMicrotask(() => created.open());
      return created.socket;
    },
    rooms: async () => options.rooms ?? [ ROOM_A, ROOM_B ],
    now: options.now ?? (() => DAY.getTime()),
    onError: error => { errors.push(error); },
    initialRetryDelayMs: 0,
    maxRetryDelayMs: 0,
    sleep: options.sleep ?? (async () => undefined),
  });
  const socketFor = (roomId: string, day: Date = DAY) => {
    const topic = roomMessagesDocumentIri(SCOPE, roomId, day);
    const socket = sockets.get(`wss://pod.example/.notifications/websocket/${encodeURIComponent(topic)}`);
    expect(socket, `a socket for ${roomId}`).toBeDefined();
    return socket!;
  };
  return {
    tracker: instance,
    fetch,
    errors,
    socketFor,
    /** Deliver a notification for the topic of `roomId`, as the Pod would. */
    notify(roomId: string, changed?: string) {
      const topic = roomMessagesDocumentIri(SCOPE, roomId, DAY);
      socketFor(roomId).emit(JSON.stringify({ type: 'Update', object: changed ?? topic, target: topic, state: 'etag' }));
    },
  };
}

describe('tracking room changes through subscriptions', () => {
  it('normalizes a subject hint to its shared document and treats a container as a broad hint', async () => {
    const f = tracker({ rooms: [ ROOM_A ] });
    await f.tracker.start();
    await f.tracker.settle({ scope: SCOPE, ...await f.tracker.pending({ scope: SCOPE }), full: true });
    const documentIri = roomMessagesDocumentIri(SCOPE, ROOM_A, DAY);
    f.notify(ROOM_A, `${documentIri}#message-id`);
    expect(await f.tracker.pending({ scope: SCOPE })).toMatchObject({
      documentChanges: [{ roomId: ROOM_A, documentIri }], reconcileRooms: [],
    });
    await f.tracker.settle({ scope: SCOPE, ...await f.tracker.pending({ scope: SCOPE }) });
    f.notify(ROOM_A, roomDirectoryIri(SCOPE, ROOM_A));
    expect(await f.tracker.pending({ scope: SCOPE })).toMatchObject({
      documentChanges: [], reconcileRooms: [ ROOM_A ],
    });
    f.tracker.stop();
  });

  it('keeps the exact old-date document hint for bounded reconciliation', async () => {
    const f = tracker({ rooms: [ ROOM_A ] });
    await f.tracker.start();
    await f.tracker.settle({ scope: SCOPE, ...await f.tracker.pending({ scope: SCOPE }), full: true });
    const older = roomMessagesDocumentIri(SCOPE, ROOM_A, new Date('2026-09-01T10:00:00Z'));
    f.notify(ROOM_A, older);
    expect(await f.tracker.pending({ scope: SCOPE })).toMatchObject({
      documentChanges: [{ roomId: ROOM_A, documentIri: older }], reconcileRooms: [],
    });
    f.tracker.stop();
  });

  it('acknowledges only the exact document read and retains another document in the same room', async () => {
    const f = tracker({ rooms: [ ROOM_A ] });
    await f.tracker.start();
    await f.tracker.settle({ scope: SCOPE, ...await f.tracker.pending({ scope: SCOPE }), full: true });
    const current = roomMessagesDocumentIri(SCOPE, ROOM_A, DAY);
    const older = roomMessagesDocumentIri(SCOPE, ROOM_A, new Date('2026-09-01T10:00:00Z'));
    f.notify(ROOM_A, current); f.notify(ROOM_A, older);
    const snapshot = await f.tracker.pending({ scope: SCOPE });
    await f.tracker.settle({ scope: SCOPE, rooms: [], snapshot: snapshot.snapshot,
      documentChanges: [{ roomId: ROOM_A, documentIri: current }],
    });
    expect(await f.tracker.pending({ scope: SCOPE })).toMatchObject({
      rooms: [ ROOM_A ], documentChanges: [{ roomId: ROOM_A, documentIri: older }],
    });
    f.tracker.stop();
  });

  it('retains a newer hint while an older read acknowledges the same document', async () => {
    const f = tracker({ rooms: [ ROOM_A ] });
    await f.tracker.start();
    await f.tracker.settle({ scope: SCOPE, ...await f.tracker.pending({ scope: SCOPE }), full: true });
    const documentIri = roomMessagesDocumentIri(SCOPE, ROOM_A, DAY);
    f.notify(ROOM_A); const snapshot = await f.tracker.pending({ scope: SCOPE }); f.notify(ROOM_A);
    await f.tracker.settle({ scope: SCOPE, rooms: [], snapshot: snapshot.snapshot,
      documentChanges: [{ roomId: ROOM_A, documentIri }],
    });
    expect(await f.tracker.pending({ scope: SCOPE })).toMatchObject({ documentChanges: [{ roomId: ROOM_A, documentIri }] });
    f.tracker.stop();
  });

  it('does not acknowledge initial catch-up with an exact document read', async () => {
    const f = tracker({ rooms: [ ROOM_A ] });
    await f.tracker.start(); f.notify(ROOM_A);
    const snapshot = await f.tracker.pending({ scope: SCOPE });
    await f.tracker.settle({ scope: SCOPE, rooms: [], snapshot: snapshot.snapshot,
      documentChanges: [{ roomId: ROOM_A, documentIri: roomMessagesDocumentIri(SCOPE, ROOM_A, DAY) }],
    });
    expect(await f.tracker.pending({ scope: SCOPE })).toMatchObject({ rooms: [ ROOM_A ], reconcileRooms: [ ROOM_A ] });
    f.tracker.stop();
  });

  it('does not acknowledge a newer notification with an older concurrent snapshot', async () => {
    const { tracker: instance, notify } = tracker({ rooms: [ ROOM_A ] });
    await instance.start();
    notify(ROOM_A);
    const first = await instance.pending({ scope: SCOPE });
    const concurrent = await instance.pending({ scope: SCOPE });
    notify(ROOM_A);
    await instance.settle({ scope: SCOPE, ...first });
    await instance.settle({ scope: SCOPE, ...concurrent });
    expect((await instance.pending({ scope: SCOPE })).rooms).toEqual([ ROOM_A ]);
    const latest = await instance.pending({ scope: SCOPE });
    await instance.settle({ scope: SCOPE, ...latest });
    expect((await instance.pending({ scope: SCOPE })).rooms).toEqual([]);
    instance.stop();
  });

  it('requires a current scoped observation and keeps unknown changes until a full read', async () => {
    const { tracker: instance, notify } = tracker({ rooms: [ ROOM_A ] });
    await instance.start();
    const initial = await instance.pending({ scope: SCOPE });
    await instance.settle({ scope: SCOPE, rooms: initial.rooms });
    await instance.settle({ scope: 'https://another.example/', ...initial });
    expect((await instance.pending({ scope: SCOPE })).rooms).toEqual([ ROOM_A ]);
    notify(ROOM_A, 'https://elsewhere.example/unknown');
    const before = await instance.pending({ scope: SCOPE });
    await instance.refresh();
    expect((await instance.pending({ scope: SCOPE })).trust).toBe('all');
    notify(ROOM_A, 'https://elsewhere.example/another');
    await instance.settle({ scope: SCOPE, ...before, full: true });
    expect((await instance.pending({ scope: SCOPE })).trust).toBe('all');
    const latest = await instance.pending({ scope: SCOPE });
    await instance.settle({ scope: SCOPE, ...latest, full: true });
    expect((await instance.pending({ scope: SCOPE })).trust).toBe('changed');
    instance.stop();
    await instance.start();
    await instance.settle({ scope: SCOPE, ...initial, full: true });
    expect((await instance.pending({ scope: SCOPE })).rooms).toEqual([ ROOM_A ]);
    instance.stop();
  });
  it('does not trust a created channel before its WebSocket opens', async () => {
    const { tracker: instance, socketFor } = tracker({ rooms: [ ROOM_A ], autoOpen: false });
    await instance.start();
    expect((await instance.pending({ scope: SCOPE })).trust).toBe('all');
    socketFor(ROOM_A).open();
    expect(await instance.pending({ scope: SCOPE })).toMatchObject({ trust: 'changed', rooms: [ ROOM_A ] });
    instance.stop();
  });

  it('keeps a disconnected room untrusted when another socket opens', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const { tracker: instance, socketFor } = tracker({ autoOpen: false, sleep: async () => gate });
    await instance.start();
    socketFor(ROOM_A).open();
    socketFor(ROOM_A).socket.close();
    await Promise.resolve();
    socketFor(ROOM_B).open();
    expect((await instance.pending({ scope: SCOPE })).trust).toBe('all');
    instance.stop();
    release();
  });

  it('retains a catch-up read after reconnection even if the gap was settled', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const { tracker: instance, socketFor, fetch } = tracker({ rooms: [ ROOM_A ], sleep: async () => gate });
    await instance.start();
    const beforeGap = await instance.pending({ scope: SCOPE });
    await instance.settle({ scope: SCOPE, ...beforeGap });
    socketFor(ROOM_A).socket.close();
    await vi.waitFor(async () => expect((await instance.pending({ scope: SCOPE })).trust).toBe('all'));
    const gap = await instance.pending({ scope: SCOPE });
    await instance.settle({ scope: SCOPE, ...gap, full: true });
    release();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    await vi.waitFor(async () => expect(await instance.pending({ scope: SCOPE }))
      .toMatchObject({ trust: 'changed', rooms: [ ROOM_A ] }));
    instance.stop();
  });
  it('watches each room\'s current day document and reports only what changed', async () => {
    const { tracker: instance, fetch, notify } = tracker();
    await instance.start();
    const initial = await instance.pending({ scope: SCOPE });
    await instance.settle({ scope: SCOPE, ...initial });

    // One channel per room, on the document that actually changes.
    expect(fetch).toHaveBeenCalledTimes(2);
    const topics = fetch.mock.calls.map(call => (JSON.parse(String((call[1] as RequestInit).body)) as { topic: string }).topic);
    expect(topics).toEqual([
      roomMessagesDocumentIri(SCOPE, ROOM_A, DAY),
      roomMessagesDocumentIri(SCOPE, ROOM_B, DAY),
    ]);
    expect(await instance.pending({ scope: SCOPE })).toMatchObject({ trust: 'changed', rooms: [] });

    notify(ROOM_B);
    expect(await instance.pending({ scope: SCOPE })).toMatchObject({ trust: 'changed', rooms: [ ROOM_B ] });
    // A room the pass read may be forgotten; the other stays pending.
    await instance.settle({ scope: SCOPE, ...await instance.pending({ scope: SCOPE }), rooms: [ ROOM_B ] });
    expect(await instance.pending({ scope: SCOPE })).toMatchObject({ trust: 'changed', rooms: [] });
    instance.stop();
  });

  it('places a change to anything else inside the room\'s directory', async () => {
    const { tracker: instance, notify } = tracker();
    await instance.start();
    const initial = await instance.pending({ scope: SCOPE });
    await instance.settle({ scope: SCOPE, ...initial });
    // A day container being created, or the chat document being updated.
    notify(ROOM_A, `${roomDirectoryIri(SCOPE, ROOM_A)}2026/09/28/`);
    expect(await instance.pending({ scope: SCOPE })).toMatchObject({ trust: 'changed', rooms: [ ROOM_A ] });
    instance.stop();
  });

  it('stops claiming completeness for a change it cannot place', async () => {
    const { tracker: instance, notify } = tracker();
    await instance.start();
    const initial = await instance.pending({ scope: SCOPE });
    await instance.settle({ scope: SCOPE, ...initial });
    notify(ROOM_A, 'https://elsewhere.example/something');
    // A change we cannot attribute schedules an immediate full read of the observed rooms.
    expect(await instance.pending({ scope: SCOPE })).toMatchObject({ trust: 'all', rooms: [ ROOM_A, ROOM_B ] });
    instance.stop();
  });

  it('stops claiming completeness when a socket drops, and recovers when it is back', async () => {
    // Hold the reconnect open so the gap is observable, then let it close.
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const { tracker: instance, socketFor, errors } = tracker({ rooms: [ ROOM_A ], sleep: async () => await gate });
    await instance.start();
    const initial = await instance.pending({ scope: SCOPE });
    await instance.settle({ scope: SCOPE, ...initial });
    expect(await instance.pending({ scope: SCOPE })).toMatchObject({ trust: 'changed', rooms: [] });

    // A dropped socket means changes may be missed until the channel is back.
    socketFor(ROOM_A).socket.close();
    await vi.waitFor(async () => {
      expect(await instance.pending({ scope: SCOPE })).toMatchObject({ trust: 'all', rooms: [ ROOM_A ] });
    });
    release?.();
    // A fresh channel also requires pulling any changes missed during the gap.
    await vi.waitFor(async () => {
      expect(await instance.pending({ scope: SCOPE })).toMatchObject({ trust: 'changed', rooms: [ ROOM_A ] });
    });
    expect(errors).toEqual([]);
    instance.stop();
  });

  it('degrades to reading everything when a subscription cannot be created', async () => {
    const roomB = roomMessagesDocumentIri(SCOPE, ROOM_B, DAY);
    const { tracker: instance, errors } = tracker({ failTopic: topic => topic === roomB });
    await instance.start();
    const initial = await instance.pending({ scope: SCOPE });
    await instance.settle({ scope: SCOPE, ...initial });
    expect(errors).toHaveLength(1);
    expect(await instance.pending({ scope: SCOPE })).toMatchObject({ trust: 'all', rooms: [] });
    instance.stop();
  });

  it('re-subscribes when the day rolls over and drops the stale topic', async () => {
    let now = DAY.getTime();
    const { tracker: instance, fetch } = tracker({ rooms: [ ROOM_A ], now: () => now });
    await instance.start();
    const initial = await instance.pending({ scope: SCOPE });
    await instance.settle({ scope: SCOPE, ...initial });
    expect(fetch).toHaveBeenCalledTimes(1);

    now += 24 * 60 * 60 * 1000;
    await instance.refresh();
    expect(fetch).toHaveBeenCalledTimes(2);
    const topics = fetch.mock.calls.map(call => (JSON.parse(String((call[1] as RequestInit).body)) as { topic: string }).topic);
    expect(topics[1]).toBe(roomMessagesDocumentIri(SCOPE, ROOM_A, new Date(now)));
    // The new day's subscription schedules a catch-up read before claiming nothing changed.
    expect(await instance.pending({ scope: SCOPE })).toMatchObject({ trust: 'changed', rooms: [ ROOM_A ] });
    instance.stop();
  });

  it('forgets everything and stops watching when stopped', async () => {
    const { tracker: instance, notify } = tracker();
    await instance.start();
    const initial = await instance.pending({ scope: SCOPE });
    await instance.settle({ scope: SCOPE, ...initial });
    notify(ROOM_A);
    instance.stop();
    expect(await instance.pending({ scope: SCOPE })).toMatchObject({ trust: 'all', rooms: [] });
  });

  it('produces a constant-sized authenticated token that a tampered or foreign token cannot clear', async () => {
    const { tracker: instance, notify } = tracker({ rooms: [ ROOM_A ] });
    await instance.start();
    await instance.settle({ scope: SCOPE, ...await instance.pending({ scope: SCOPE }), full: true });
    notify(ROOM_A);
    const snapshot = await instance.pending({ scope: SCOPE });
    // The snapshot is a string token, not a live object, and is bounded in size (no per-room map).
    expect(typeof snapshot.snapshot).toBe('string');
    expect((snapshot.snapshot as string).length).toBeLessThan(600);

    // A forged token, a token from another scope, and a truncated token all clear nothing.
    await instance.settle({ scope: SCOPE, rooms: [ ROOM_A ], snapshot: 'forged.deadbeef' });
    await instance.settle({ scope: 'https://other.example/', rooms: [ ROOM_A ], snapshot: snapshot.snapshot });
    await instance.settle({ scope: SCOPE, rooms: [ ROOM_A ], snapshot: (snapshot.snapshot as string).slice(0, -4) });
    expect((await instance.pending({ scope: SCOPE })).rooms).toEqual([ ROOM_A ]);

    // The genuine token still settles the room.
    await instance.settle({ scope: SCOPE, rooms: [ ROOM_A ], snapshot: snapshot.snapshot });
    expect((await instance.pending({ scope: SCOPE })).rooms).toEqual([]);
    instance.stop();
  });

  it('rejects an old token after the source is reincarnated', async () => {
    const first = tracker({ rooms: [ ROOM_A ] });
    await first.tracker.start();
    await first.tracker.settle({ scope: SCOPE, ...await first.tracker.pending({ scope: SCOPE }), full: true });
    first.notify(ROOM_A);
    const oldSnapshot = await first.tracker.pending({ scope: SCOPE });

    // A restart creates a new tracker with a fresh secret/incarnation, as a process restart would.
    const second = tracker({ rooms: [ ROOM_A ] });
    await second.tracker.start();
    const beforeOldToken = await second.tracker.pending({ scope: SCOPE });
    // The old token is invalid at the new source: it must not clear the new tracker's own state.
    await second.tracker.settle({ scope: SCOPE, rooms: [ ROOM_A ], snapshot: oldSnapshot.snapshot });
    expect(await second.tracker.pending({ scope: SCOPE })).toMatchObject({ rooms: [ ROOM_A ] });
    expect(beforeOldToken.rooms).toEqual([ ROOM_A ]);
    second.tracker.stop();
    first.tracker.stop();
  });

  it('does not let a document-only settlement clear a room-wide reconcile marker', async () => {
    const { tracker: instance, socketFor } = tracker({ rooms: [ ROOM_A ] });
    await instance.start();
    await instance.settle({ scope: SCOPE, ...await instance.pending({ scope: SCOPE }), full: true });
    // A connection gap marks the whole room for reconciliation, not just a document.
    socketFor(ROOM_A).socket.close();
    await vi.waitFor(async () => expect((await instance.pending({ scope: SCOPE })).reconcileRooms).toContain(ROOM_A));
    const snapshot = await instance.pending({ scope: SCOPE });
    // Settling the room's *document* must not clear the room-wide reconcile marker.
    await instance.settle({ scope: SCOPE, rooms: [], documentChanges: [ { roomId: ROOM_A, documentIri: roomMessagesDocumentIri(SCOPE, ROOM_A, DAY) } ], snapshot: snapshot.snapshot });
    expect((await instance.pending({ scope: SCOPE })).reconcileRooms).toContain(ROOM_A);
    instance.stop();
  });
});
