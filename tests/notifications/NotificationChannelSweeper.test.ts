import type {
  KeyValueStorage,
  NotificationChannel,
  NotificationChannelStorage,
  ResourceIdentifier,
} from '@solid/community-server';
import { WebSocketMap } from '@solid/community-server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import {
  NOTIFICATION_CHANNEL_SWEEP_INTERVAL_MINUTES,
  NotificationChannelSweeper,
} from '../../src/notifications/NotificationChannelSweeper';

const BASE_URL = 'https://pod.example/';
const TOPIC = 'https://pod.example/alice/notes.ttl';

/** A socket is only ever inspected through `WebSocketMap`, so a listener stub is enough. */
function fakeSocket(): WebSocket {
  return { on: vi.fn(), send: vi.fn(), close: vi.fn() } as unknown as WebSocket;
}

function channel(id: string, topic = TOPIC): NotificationChannel {
  return {
    id: `${BASE_URL}.notifications/WebSocketChannel2023/${id}`,
    type: 'http://www.w3.org/ns/solid/notifications#WebSocketChannel2023',
    topic,
  };
}

/** In-memory `NotificationChannelStorage` that keeps the topic index in sync like CSS does. */
function createChannelStorage() {
  const channels = new Map<string, NotificationChannel>();
  const topics = new Map<string, string[]>();
  const storage: NotificationChannelStorage = {
    get: async(id) => channels.get(id),
    getAll: async(topic: ResourceIdentifier) => topics.get(topic.path) ?? [],
    add: async(entry) => {
      channels.set(entry.id, entry);
      topics.set(entry.topic, [ ...topics.get(entry.topic) ?? [], entry.id ]);
    },
    update: async(entry) => {
      channels.set(entry.id, entry);
    },
    delete: async(id) => {
      const entry = channels.get(id);
      if (!entry) {
        return false;
      }
      channels.delete(id);
      const remaining = (topics.get(entry.topic) ?? []).filter((candidate) => candidate !== id);
      if (remaining.length > 0) {
        topics.set(entry.topic, remaining);
      } else {
        topics.delete(entry.topic);
      }
      return true;
    },
  };
  return { storage, channels };
}

/**
 * Minimal `KeyValueStorage` over a Map, holding the same entries the notification storage writes.
 * The backing Map is returned so a test can publish a new record the way `KeyValueChannelStorage.add` does.
 */
function createChannelIndex(entries: Array<[ string, unknown ]>): {
  storage: KeyValueStorage<string, unknown>;
  entries: Map<string, unknown>;
} {
  const map = new Map(entries);
  const storage: KeyValueStorage<string, unknown> = {
    get: async(key) => map.get(key),
    has: async(key) => map.has(key),
    set: async(key, value) => {
      map.set(key, value);
      return storage;
    },
    delete: async(key) => map.delete(key),
    entries: async function* entries() {
      for (const entry of [ ...map.entries() ]) {
        yield entry;
      }
    },
  };
  return { storage, entries: map };
}

async function createSweeper(
  channels: NotificationChannel[],
  options: { socketIds?: string[]; baseUrl?: string; intervalMinutes?: number } = {},
) {
  const { storage, channels: stored } = createChannelStorage();
  for (const entry of channels) {
    await storage.add(entry);
  }
  const index = createChannelIndex([
    ...channels.map((entry): [ string, unknown ] => [ encodeURIComponent(entry.id), entry ]),
    ...channels.map((entry): [ string, unknown ] => [ encodeURIComponent(entry.topic), [ entry.id ] ]),
  ]);
  const socketMap = new WebSocketMap();
  for (const id of options.socketIds ?? []) {
    socketMap.add(id, fakeSocket());
  }
  const sweeper = new NotificationChannelSweeper(
    storage,
    index.storage,
    socketMap,
    options.baseUrl ?? BASE_URL,
    options.intervalMinutes ?? NOTIFICATION_CHANNEL_SWEEP_INTERVAL_MINUTES,
  );
  /** Publishes a channel the way `KeyValueChannelStorage.add` does: record row first, then topic index. */
  const publish = async(entry: NotificationChannel): Promise<void> => {
    await storage.add(entry);
    index.entries.set(encodeURIComponent(entry.id), entry);
  };
  return { sweeper, storage, socketMap, channels: stored, indexEntries: index.entries, publish };
}

describe('NotificationChannelSweeper', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reclaims every channel without a live socket on the startup sweep', async() => {
    const { sweeper, channels } = await createSweeper([ channel('a'), channel('b') ]);

    await expect(sweeper.sweep(true)).resolves.toBe(2);

    expect([ ...channels.keys() ]).toEqual([]);
  });

  it('keeps channels that still have a live socket', async() => {
    const alive = channel('alive');
    const orphan = channel('orphan');
    const { sweeper, channels } = await createSweeper([ alive, orphan ], { socketIds: [ alive.id ] });

    await expect(sweeper.sweep(true)).resolves.toBe(1);

    expect([ ...channels.keys() ]).toEqual([ alive.id ]);
  });

  it('only reclaims channels created under its own baseUrl', async() => {
    const foreign = channel('foreign');
    foreign.id = 'https://other.example/.notifications/WebSocketChannel2023/foreign';
    const { sweeper, channels } = await createSweeper([ channel('own'), foreign ]);

    await expect(sweeper.sweep(true)).resolves.toBe(1);

    expect([ ...channels.keys() ]).toEqual([ foreign.id ]);
  });

  it('does not mistake a lookalike host for its own when baseUrl has no trailing slash', async() => {
    const lookalike = channel('lookalike');
    lookalike.id = 'https://pod.example.evil/.notifications/WebSocketChannel2023/lookalike';
    const { sweeper, channels } = await createSweeper([ channel('own'), lookalike ], { baseUrl: 'https://pod.example' });

    await expect(sweeper.sweep(true)).resolves.toBe(1);

    expect([ ...channels.keys() ]).toEqual([ lookalike.id ]);
  });

  it('gives a freshly created channel one interval of grace before the periodic sweep reclaims it', async() => {
    const fresh = channel('fresh');
    const { sweeper, channels } = await createSweeper([ fresh ]);

    // The first periodic pass only marks the channel: its WebSocket may still be opening.
    await expect(sweeper.sweep(false)).resolves.toBe(0);
    expect([ ...channels.keys() ]).toEqual([ fresh.id ]);

    // The next pass, one interval later, reclaims it.
    await expect(sweeper.sweep(false)).resolves.toBe(1);
    expect([ ...channels.keys() ]).toEqual([]);
  });

  it('forgets a channel that connected in the meantime', async() => {
    const late = channel('late');
    const { sweeper, socketMap, channels } = await createSweeper([ late ]);

    await sweeper.sweep(false);
    socketMap.add(late.id, fakeSocket());

    await expect(sweeper.sweep(false)).resolves.toBe(0);
    expect([ ...channels.keys() ]).toEqual([ late.id ]);
  });

  it('skips topic index rows and unrelated stored values', async() => {
    const stored = channel('stored');
    const { storage, channels } = createChannelStorage();
    await storage.add(stored);
    const index = createChannelIndex([
      [ 'topic-row', [ stored.id ] ],
      [ 'unrelated', { some: 'value' } ],
      [ 'literal', 42 ],
      [ 'list', [ 'not-a-channel' ] ],
      [ 'channel-row', stored ],
    ]);
    const socketMap = new WebSocketMap();
    socketMap.add(stored.id, fakeSocket());
    const sweeper = new NotificationChannelSweeper(storage, index.storage, socketMap, BASE_URL);

    await expect(sweeper.sweep(true)).resolves.toBe(0);
    expect([ ...channels.keys() ]).toEqual([ stored.id ]);
  });

  it('sweeps on startup and then keeps sweeping on a bounded interval until finalized', async() => {
    vi.useFakeTimers();
    const orphan = channel('orphan');
    const { sweeper, channels, publish } = await createSweeper([ orphan ]);

    await sweeper.handle();

    // The startup sweep already reclaimed the persisted orphan.
    expect([ ...channels.keys() ]).toEqual([]);

    const later = channel('later');
    await publish(later);

    // One interval marks it, the next one reclaims it, without any external trigger.
    await vi.advanceTimersByTimeAsync(NOTIFICATION_CHANNEL_SWEEP_INTERVAL_MINUTES * 60_000);
    expect([ ...channels.keys() ]).toEqual([ later.id ]);
    await vi.advanceTimersByTimeAsync(NOTIFICATION_CHANNEL_SWEEP_INTERVAL_MINUTES * 60_000);
    expect([ ...channels.keys() ]).toEqual([]);

    await sweeper.finalize();

    const afterFinalize = channel('after-finalize');
    await publish(afterFinalize);
    await vi.advanceTimersByTimeAsync(NOTIFICATION_CHANNEL_SWEEP_INTERVAL_MINUTES * 60_000 * 3);
    expect([ ...channels.keys() ]).toEqual([ afterFinalize.id ]);
  });

  it('does not start a second sweep while one is running', async() => {
    const orphan = channel('orphan');
    const { sweeper } = await createSweeper([ orphan ]);

    const [ first, second ] = await Promise.all([ sweeper.sweep(true), sweeper.sweep(true) ]);

    expect([ first, second ].sort()).toEqual([ 0, 1 ]);
  });

  it('keeps one startup sweep and one timer when the initializer runs twice', async() => {
    vi.useFakeTimers();
    const { sweeper } = await createSweeper([]);
    const sweep = vi.spyOn(sweeper, 'sweep');

    // The CSS start sequence was observed to call this initializer twice per boot.
    await sweeper.handle();
    await sweeper.handle();
    expect(sweep).toHaveBeenCalledTimes(1);
    // One timer, not two: two timers would collapse the two-sighting grace period
    // into two sweeps milliseconds apart, which is the same as having no grace.
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(NOTIFICATION_CHANNEL_SWEEP_INTERVAL_MINUTES * 60_000);
    expect(sweep).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('unrefs the interval so the sweep never holds the process open', async() => {
    const { sweeper } = await createSweeper([]);

    await sweeper.handle();

    // An ops fallback must not become a reason to keep a shutting-down server alive.
    const timer = (sweeper as unknown as { timer?: NodeJS.Timeout }).timer;
    expect(timer).toBeDefined();
    expect(timer?.hasRef()).toBe(false);

    await sweeper.finalize();
    expect((sweeper as unknown as { timer?: NodeJS.Timeout }).timer).toBeUndefined();
  });
});
