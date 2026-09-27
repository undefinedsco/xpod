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
    emit: (data: unknown) => { for (const listener of listeners.get('message') ?? []) listener({ data }); },
  };
}

function tracker(options: {
  rooms?: readonly string[];
  failTopic?: (topic: string) => boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
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
  it('watches each room\'s current day document and reports only what changed', async () => {
    const { tracker: instance, fetch, notify } = tracker();
    await instance.start();

    // One channel per room, on the document that actually changes.
    expect(fetch).toHaveBeenCalledTimes(2);
    const topics = fetch.mock.calls.map(call => (JSON.parse(String((call[1] as RequestInit).body)) as { topic: string }).topic);
    expect(topics).toEqual([
      roomMessagesDocumentIri(SCOPE, ROOM_A, DAY),
      roomMessagesDocumentIri(SCOPE, ROOM_B, DAY),
    ]);
    expect(await instance.pending({ scope: SCOPE })).toEqual({ trust: 'changed', rooms: [] });

    notify(ROOM_B);
    expect(await instance.pending({ scope: SCOPE })).toEqual({ trust: 'changed', rooms: [ ROOM_B ] });
    // A room the pass read may be forgotten; the other stays pending.
    await instance.settle({ scope: SCOPE, rooms: [ ROOM_B ] });
    expect(await instance.pending({ scope: SCOPE })).toEqual({ trust: 'changed', rooms: [] });
    instance.stop();
  });

  it('places a change to anything else inside the room\'s directory', async () => {
    const { tracker: instance, notify } = tracker();
    await instance.start();
    // A day container being created, or the chat document being updated.
    notify(ROOM_A, `${roomDirectoryIri(SCOPE, ROOM_A)}2026/09/28/`);
    expect(await instance.pending({ scope: SCOPE })).toEqual({ trust: 'changed', rooms: [ ROOM_A ] });
    instance.stop();
  });

  it('stops claiming completeness for a change it cannot place', async () => {
    const { tracker: instance, notify } = tracker();
    await instance.start();
    notify(ROOM_A, 'https://elsewhere.example/something');
    // A change we cannot attribute could be anywhere, so every room has to be read.
    expect(await instance.pending({ scope: SCOPE })).toEqual({ trust: 'all', rooms: [] });
    instance.stop();
  });

  it('stops claiming completeness when a socket drops, and recovers when it is back', async () => {
    // Hold the reconnect open so the gap is observable, then let it close.
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const { tracker: instance, socketFor, errors } = tracker({ rooms: [ ROOM_A ], sleep: async () => await gate });
    await instance.start();
    expect(await instance.pending({ scope: SCOPE })).toEqual({ trust: 'changed', rooms: [] });

    // A dropped socket means changes may be missed until the channel is back.
    socketFor(ROOM_A).socket.close();
    await vi.waitFor(async () => {
      expect(await instance.pending({ scope: SCOPE })).toEqual({ trust: 'all', rooms: [] });
    });
    release?.();
    // A fresh channel means we can account for everything again.
    await vi.waitFor(async () => {
      expect(await instance.pending({ scope: SCOPE })).toEqual({ trust: 'changed', rooms: [] });
    });
    expect(errors).toEqual([]);
    instance.stop();
  });

  it('degrades to reading everything when a subscription cannot be created', async () => {
    const roomB = roomMessagesDocumentIri(SCOPE, ROOM_B, DAY);
    const { tracker: instance, errors } = tracker({ failTopic: topic => topic === roomB });
    await instance.start();
    expect(errors).toHaveLength(1);
    expect(await instance.pending({ scope: SCOPE })).toEqual({ trust: 'all', rooms: [] });
    instance.stop();
  });

  it('re-subscribes when the day rolls over and drops the stale topic', async () => {
    let now = DAY.getTime();
    const { tracker: instance, fetch } = tracker({ rooms: [ ROOM_A ], now: () => now });
    await instance.start();
    expect(fetch).toHaveBeenCalledTimes(1);

    now += 24 * 60 * 60 * 1000;
    await instance.refresh();
    expect(fetch).toHaveBeenCalledTimes(2);
    const topics = fetch.mock.calls.map(call => (JSON.parse(String((call[1] as RequestInit).body)) as { topic: string }).topic);
    expect(topics[1]).toBe(roomMessagesDocumentIri(SCOPE, ROOM_A, new Date(now)));
    // The old day's topic is no longer watched, and the source still accounts for everything.
    expect(await instance.pending({ scope: SCOPE })).toEqual({ trust: 'changed', rooms: [] });
    instance.stop();
  });

  it('forgets everything and stops watching when stopped', async () => {
    const { tracker: instance, notify } = tracker();
    await instance.start();
    notify(ROOM_A);
    instance.stop();
    expect(await instance.pending({ scope: SCOPE })).toEqual({ trust: 'all', rooms: [] });
  });
});
