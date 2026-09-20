import type { NotificationChannel, NotificationChannelStorage, ResourceIdentifier } from '@solid/community-server';
import { WebSocketMap } from '@solid/community-server';
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { ReclaimingWebSocket2023Storer } from '../../src/notifications/ReclaimingWebSocket2023Storer';

const TOPIC = 'https://pod.example/alice/notes.ttl';

/** A socket that behaves like `ws` for the only events this component cares about. */
class FakeSocket extends EventEmitter {
  public readonly sent: string[] = [];

  public send(data: string): void {
    this.sent.push(data);
  }

  public close(): void {
    this.emit('close');
  }
}

function channel(id: string): NotificationChannel {
  return {
    id: `https://pod.example/.notifications/WebSocketChannel2023/${id}`,
    type: 'http://www.w3.org/ns/solid/notifications#WebSocketChannel2023',
    topic: TOPIC,
  };
}

function createStorage() {
  const channels = new Map<string, NotificationChannel>();
  const storage: NotificationChannelStorage = {
    get: async(id) => channels.get(id),
    getAll: async(_topic: ResourceIdentifier) => [ ...channels.keys() ],
    add: async(entry) => {
      channels.set(entry.id, entry);
    },
    update: async(entry) => {
      channels.set(entry.id, entry);
    },
    delete: async(id) => channels.delete(id),
  };
  return { storage, channels };
}

/** The reclaim runs in a listener, so let the microtask queue drain. */
async function flush(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function createStorer() {
  const { storage, channels } = createStorage();
  const socketMap = new WebSocketMap();
  const storer = new ReclaimingWebSocket2023Storer(storage, socketMap);
  return { storer, socketMap, channels };
}

describe('ReclaimingWebSocket2023Storer', () => {
  it('deletes the channel when its socket closes', async() => {
    const { storer, channels } = createStorer();
    const entry = channel('a');
    await channels.set(entry.id, entry);
    const socket = new FakeSocket();

    await storer.handle({ channel: entry, webSocket: socket as unknown as WebSocket });
    expect(channels.has(entry.id)).toBe(true);

    socket.close();
    await flush();

    expect(channels.has(entry.id)).toBe(false);
  });

  it('deletes the channel when its socket errors', async() => {
    const { storer, channels } = createStorer();
    const entry = channel('b');
    await channels.set(entry.id, entry);
    const socket = new FakeSocket();

    await storer.handle({ channel: entry, webSocket: socket as unknown as WebSocket });
    socket.emit('error', new Error('boom'));
    await flush();

    expect(channels.has(entry.id)).toBe(false);
  });

  it('keeps the channel until the last socket of that channel is gone', async() => {
    const { storer, channels } = createStorer();
    const entry = channel('shared');
    await channels.set(entry.id, entry);
    const first = new FakeSocket();
    const second = new FakeSocket();

    await storer.handle({ channel: entry, webSocket: first as unknown as WebSocket });
    await storer.handle({ channel: entry, webSocket: second as unknown as WebSocket });

    first.close();
    await flush();
    expect(channels.has(entry.id)).toBe(true);

    second.close();
    await flush();
    expect(channels.has(entry.id)).toBe(false);
  });

  it('leaves channels of other live sockets alone', async() => {
    const { storer, socketMap, channels } = createStorer();
    const closing = channel('closing');
    const kept = channel('kept');
    await channels.set(closing.id, closing);
    await channels.set(kept.id, kept);

    const closingSocket = new FakeSocket();
    const keptSocket = new FakeSocket();
    await storer.handle({ channel: closing, webSocket: closingSocket as unknown as WebSocket });
    await storer.handle({ channel: kept, webSocket: keptSocket as unknown as WebSocket });

    closingSocket.close();
    await flush();

    expect(channels.has(closing.id)).toBe(false);
    expect(channels.has(kept.id)).toBe(true);
    expect(socketMap.has(kept.id)).toBe(true);
  });

  it('still tracks the socket in the map, like the CSS implementation it replaces', async() => {
    const { storer, socketMap } = createStorer();
    const entry = channel('tracked');
    const socket = new FakeSocket();

    await storer.handle({ channel: entry, webSocket: socket as unknown as WebSocket });
    expect(socketMap.hasEntry(entry.id, socket as unknown as WebSocket)).toBe(true);

    socket.close();
    await flush();
    expect(socketMap.has(entry.id)).toBe(false);
  });

  it('keeps the process alive when the channel deletion fails', async() => {
    const { storage, channels } = createStorage();
    const entry = channel('failing');
    await channels.set(entry.id, entry);
    storage.delete = async() => {
      throw new Error('storage is gone');
    };
    const storer = new ReclaimingWebSocket2023Storer(storage, new WebSocketMap());
    const socket = new FakeSocket();

    await storer.handle({ channel: entry, webSocket: socket as unknown as WebSocket });
    socket.emit('error', new Error('socket died'));
    await flush();

    // The channel survives for the sweeper to pick up; the rejection is logged, not rethrown.
    expect(channels.has(entry.id)).toBe(true);
  });
});
