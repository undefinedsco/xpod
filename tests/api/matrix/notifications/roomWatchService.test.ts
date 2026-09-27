import { describe, expect, it, vi } from 'vitest';
import {
  createMatrixRoomWatchService,
  notificationEndpointOf,
  type MatrixRoomWatch,
  type MatrixRoomWatchServiceOptions,
} from '../../../../src/api/matrix/notifications/roomWatchService';
import type { MatrixServerRoute } from '../../../../src/api/matrix/participantRoutes';

const route = (name: string, podUrl = `https://pod.example/${name.split('.')[0]}/`): MatrixServerRoute =>
  ({ webId: `https://${name}/card#me`, podUrl });

/** A watcher that answers like the real tracker: `changed` only while it is watching. */
function fakeWatch(input: { route: MatrixServerRoute; endpoint: string; rooms: () => Promise<readonly string[]> }) {
  const watch: MatrixRoomWatch & { settled: string[][]; stopped: boolean } = {
    settled: [],
    stopped: false,
    pending: async () => ({ trust: 'changed' as const, rooms: [ `${input.route.podUrl}room-1` ] }),
    settle: async ({ rooms }) => { watch.settled.push([ ...rooms ]); },
    stop: () => { watch.stopped = true; },
  };
  return watch;
}

function service(options: Partial<MatrixRoomWatchServiceOptions> = {}) {
  const started: { endpoint: string; route: MatrixServerRoute; watch: ReturnType<typeof fakeWatch> }[] = [];
  const errors: Error[] = [];
  const instance = createMatrixRoomWatchService({
    routes: async () => [ route('alice.example'), route('carol.example') ],
    rooms: async () => [ '!r:alice.example' ],
    intervalMs: 0,
    watch: async input => {
      const watch = fakeWatch(input);
      started.push({ endpoint: input.endpoint, route: input.route, watch });
      return watch;
    },
    onError: error => { errors.push(error); },
    ...options,
  });
  return { instance, started, errors };
}

describe('watching the Pods this deployment serves', () => {
  it('watches every served Pod, with the endpoint derived from its root', async () => {
    const { instance, started } = service();
    await instance.start();

    expect(started.map(entry => entry.route.podUrl).sort())
      .toEqual([ 'https://pod.example/alice/', 'https://pod.example/carol/' ]);
    expect(started[0].endpoint).toBe('https://pod.example/alice/.notifications/WebSocketChannel2023/');
    expect(instance.watchedScopes).toEqual([ 'https://pod.example/alice/', 'https://pod.example/carol/' ]);
    expect(instance.isRunning).toBe(true);
  });

  it('routes a question to that Pod\'s watcher, and says "read everything" for a Pod nobody watches', async () => {
    const { instance, started } = service();
    await instance.start();

    // The scope is the Pod root: a context selecting one Pod cannot read another's answer.
    await expect(instance.pending({ scope: 'https://pod.example/alice/' }))
      .resolves.toEqual({ trust: 'changed', rooms: [ 'https://pod.example/alice/room-1' ] });
    // Not watched (never served): the store has to read every room rather than trust silence.
    await expect(instance.pending({ scope: 'https://pod.example/dave/' }))
      .resolves.toEqual({ trust: 'all', rooms: [] });

    await instance.settle({ scope: 'https://pod.example/alice/', rooms: [ '!r:alice.example' ] });
    expect(started[0].watch.settled).toEqual([ [ '!r:alice.example' ] ]);
    // Nothing to settle for a Pod nobody watches.
    await expect(instance.settle({ scope: 'https://pod.example/dave/', rooms: [ '!r:dave.example' ] })).resolves.toBeUndefined();
  });

  it('picks up a Pod that appeared and drops one that went away', async () => {
    let routes = [ route('alice.example') ];
    const { instance, started } = service({ routes: async () => routes });
    await instance.start();
    expect(instance.watchedScopes).toEqual([ 'https://pod.example/alice/' ]);

    routes = [ route('alice.example'), route('bob.example') ];
    await instance.reconcile();
    expect(instance.watchedScopes).toEqual([ 'https://pod.example/alice/', 'https://pod.example/bob/' ]);
    expect(started).toHaveLength(2);

    routes = [ route('bob.example') ];
    await instance.reconcile();
    expect(instance.watchedScopes).toEqual([ 'https://pod.example/bob/' ]);
    // The watcher for the Pod that is no longer served is stopped, not merely forgotten.
    expect(started[0].watch.stopped).toBe(true);
    await expect(instance.pending({ scope: 'https://pod.example/alice/' })).resolves.toEqual({ trust: 'all', rooms: [] });
  });

  it('keeps the other Pods watched when one of them cannot be watched', async () => {
    const failing = service({
      watch: async input => {
        if (input.route.podUrl.includes('alice')) throw new Error('the Pod refused a subscription');
        return fakeWatch(input);
      },
    });
    await failing.instance.start();

    expect(failing.errors.map(error => error.message)).toEqual([ 'the Pod refused a subscription' ]);
    expect(failing.instance.watchedScopes).toEqual([ 'https://pod.example/carol/' ]);
    // And the Pod that failed keeps answering "read everything" rather than "nothing changed".
    await expect(failing.instance.pending({ scope: 'https://pod.example/alice/' }))
      .resolves.toEqual({ trust: 'all', rooms: [] });
  });

  it('stops everything it started, and starts nothing after that', async () => {
    const { instance, started } = service();
    await instance.start();
    instance.stop();

    expect(instance.isRunning).toBe(false);
    expect(instance.watchedScopes).toEqual([]);
    expect(started.every(entry => entry.watch.stopped)).toBe(true);

    await instance.reconcile();
    expect(started).toHaveLength(2);
  });

  it('watches nothing at all when the deployment configures no watcher', async () => {
    const { instance } = service({ watch: undefined });
    await instance.start();
    expect(instance.watchedScopes).toEqual([]);
    await expect(instance.pending({ scope: 'https://pod.example/alice/' })).resolves.toEqual({ trust: 'all', rooms: [] });
  });

  it('arms a timer for reconciliation and clears it on stop', async () => {
    vi.useFakeTimers();
    try {
      let routes = [ route('alice.example') ];
      const { instance } = service({ routes: async () => routes, intervalMs: 50 });
      await instance.start();
      routes = [ route('alice.example'), route('bob.example') ];
      await vi.advanceTimersByTimeAsync(60);
      expect(instance.watchedScopes).toHaveLength(2);

      instance.stop();
      routes = [ route('carol.example') ];
      await vi.advanceTimersByTimeAsync(120);
      expect(instance.watchedScopes).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('derives the channel endpoint the way Solid notifications define it', () => {
    expect(notificationEndpointOf('https://pod.example/alice/'))
      .toBe('https://pod.example/alice/.notifications/WebSocketChannel2023/');
    // A Pod root without its trailing slash still points at the Pod, not at a sibling path.
    expect(notificationEndpointOf('https://pod.example/alice'))
      .toBe('https://pod.example/.notifications/WebSocketChannel2023/');
  });
});
