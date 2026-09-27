import { describe, expect, it, vi } from 'vitest';
import {
  parseNotification,
  SolidNotificationSubscription,
  WEB_SOCKET_CHANNEL_2023,
  type NotificationSocket,
  type SolidChangeNotification,
} from '../../../../src/api/matrix/notifications/roomChangeSubscription';

const ENDPOINT = 'https://pod.example/.notifications/WebSocketChannel2023/';
const TOPIC = 'https://pod.example/.data/chat/room1/2026/09/27/messages.ttl';

/** A socket the test drives by hand. */
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
    drop: () => { for (const listener of listeners.get('close') ?? []) listener({}); },
    fail: () => { for (const listener of listeners.get('error') ?? []) listener({}); },
  };
}

function harness(options: { channelStatus?: number } = {}) {
  const sockets: ReturnType<typeof fakeSocket>[] = [];
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    if (options.channelStatus && options.channelStatus >= 400) {
      return new Response('', { status: options.channelStatus });
    }
    return new Response(JSON.stringify({
      id: `channel-${sockets.length + 1}`,
      type: WEB_SOCKET_CHANNEL_2023,
      topic: body.topic,
      receiveFrom: `wss://pod.example/.notifications/websocket/${sockets.length + 1}`,
    }), { status: 201, headers: { 'content-type': 'application/ld+json' } });
  });
  const changes: SolidChangeNotification[] = [];
  const errors: Error[] = [];
  const subscription = new SolidNotificationSubscription({
    endpoint: ENDPOINT,
    topic: TOPIC,
    fetch: fetch as unknown as typeof fetch,
    openSocket: () => {
      const created = fakeSocket();
      sockets.push(created);
      return created.socket;
    },
    onChange: notification => { changes.push(notification); },
    onError: error => { errors.push(error); },
    initialRetryDelayMs: 0,
    maxRetryDelayMs: 0,
    sleep: async () => undefined,
  });
  return { subscription, fetch, sockets, changes, errors };
}

describe('subscribing to a resource\'s changes', () => {
  it('creates a channel for the topic and reads what the socket pushes', async () => {
    const { subscription, fetch, sockets, changes } = harness();
    await subscription.start();

    const [ url, init ] = fetch.mock.calls[0] as [ string, RequestInit ];
    expect(url).toBe(ENDPOINT);
    expect(init.method).toBe('POST');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ type: WEB_SOCKET_CHANNEL_2023, topic: TOPIC });
    expect(subscription.id).toBe('channel-1');
    expect(sockets).toHaveLength(1);

    sockets[0].emit(JSON.stringify({ type: 'Update', object: TOPIC, target: TOPIC, state: 'etag-2' }));
    expect(changes).toEqual([ { type: 'Update', object: TOPIC, target: TOPIC, state: 'etag-2' } ]);
    subscription.stop();
  });

  it('re-subscribes after a drop, because the channel may have been reclaimed', async () => {
    const { subscription, fetch, sockets, changes } = harness();
    await subscription.start();
    sockets[0].drop();
    await vi.waitFor(() => expect(sockets).toHaveLength(2));

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(subscription.id).toBe('channel-2');
    sockets[1].emit(JSON.stringify({ object: TOPIC }));
    expect(changes).toHaveLength(1);
    subscription.stop();
  });

  it('reports a channel that cannot be created instead of pretending to watch', async () => {
    const { subscription, errors } = harness({ channelStatus: 403 });
    await expect(subscription.start()).rejects.toThrow(/answered 403/u);
    expect(errors).toEqual([]);
    expect(subscription.id).toBeUndefined();
  });

  it('reports a socket failure and keeps retrying until stopped', async () => {
    const { subscription, sockets, errors } = harness();
    await subscription.start();
    sockets[0].fail();
    await vi.waitFor(() => expect(sockets.length).toBeGreaterThanOrEqual(2));
    expect(errors[0]?.message).toMatch(/notification socket/u);
    subscription.stop();
    const countAfterStop = sockets.length;
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(sockets.length).toBe(countAfterStop);
  });

  it('stops watching when asked, and start is idempotent', async () => {
    const { subscription, fetch, sockets } = harness();
    await subscription.start();
    await subscription.start();
    expect(fetch).toHaveBeenCalledTimes(1);
    subscription.stop();
    subscription.stop();
    expect(sockets[0].socket.close).toHaveBeenCalled();
  });
});

describe('reading a notification body', () => {
  it('keeps the fields this deployment acts on', () => {
    expect(parseNotification(JSON.stringify({ type: 'Create', object: 'https://p/x', target: 'https://p/', state: 'e', published: 'now' })))
      .toEqual({ type: 'Create', object: 'https://p/x', target: 'https://p/', state: 'e', published: 'now' });
    // Bytes are what a real socket hands over.
    expect(parseNotification(Buffer.from(JSON.stringify({ object: 'https://p/x' })))).toEqual({ object: 'https://p/x' });
  });

  it('ignores anything that is not a notification it can act on', () => {
    expect(parseNotification('not json')).toBeUndefined();
    expect(parseNotification('[1,2]')).toBeUndefined();
    expect(parseNotification(JSON.stringify({ type: 'Update' }))).toBeUndefined();
    expect(parseNotification(42)).toBeUndefined();
  });
});
