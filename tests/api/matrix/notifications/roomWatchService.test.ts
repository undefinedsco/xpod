import { describe, expect, it, vi } from 'vitest';
import {
  createMatrixRoomWatchService,
  type MatrixRoomWatch,
  type MatrixRoomWatchServiceOptions,
} from '../../../../src/api/matrix/notifications/roomWatchService';
import type { MatrixServerRoute } from '../../../../src/api/matrix/participantRoutes';

const route = (name: string, podUrl = `https://pod.example/${name.split('.')[0]}/`): MatrixServerRoute =>
  ({ webId: `https://${name}/card#me`, podUrl });

/** A watcher that answers like the real tracker: `changed` only while it is watching. */
function fakeWatch(input: { route: MatrixServerRoute; rooms: () => Promise<readonly string[]> }) {
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
  const started: { route: MatrixServerRoute; watch: ReturnType<typeof fakeWatch> }[] = [];
  const errors: Error[] = [];
  const instance = createMatrixRoomWatchService({
    routes: async () => [ route('alice.example'), route('carol.example') ],
    rooms: async () => [ '!r:alice.example' ],
    intervalMs: 0,
    watch: async input => {
      const watch = fakeWatch(input);
      started.push({ route: input.route, watch });
      return watch;
    },
    onError: error => { errors.push(error); },
    ...options,
  });
  return { instance, started, errors };
}

describe('watching the Pods this deployment serves', () => {
  it('does not install watches or a timer when stopped during initial route discovery', async () => {
    vi.useFakeTimers();
    let release!: (value: MatrixServerRoute[]) => void;
    const routes = new Promise<MatrixServerRoute[]>(resolve => { release = resolve; });
    const watch = vi.fn(async input => fakeWatch(input));
    const { instance } = service({ intervalMs: 10, routes: async () => routes, watch });
    try {
      const started = instance.start();
      await Promise.resolve();
      instance.stop();
      release([ route('alice.example') ]);
      await started;
      expect(watch).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      instance.stop();
      vi.useRealTimers();
    }
  });
  it('stops trusting an existing watch when its refresh fails and retries it', async () => {
    let fail = false;
    const refresh = vi.fn(async () => { if (fail) throw new Error('room authority unavailable'); });
    const { instance } = service({ watch: async input => ({ ...fakeWatch(input), refresh }) });
    await instance.start();
    fail = true;
    await instance.reconcile();
    expect(await instance.pending({ scope: 'https://pod.example/alice/' })).toEqual({ trust: 'all', rooms: [] });
    fail = false;
    await instance.reconcile();
    expect((await instance.pending({ scope: 'https://pod.example/alice/' })).trust).toBe('changed');
    instance.stop();
  });

  it('invalidates watches when the current route inventory cannot be read', async () => {
    let fail = false;
    const { instance } = service({ routes: async () => {
      if (fail) throw new Error('routes unavailable');
      return [ route('alice.example') ];
    } });
    await instance.start();
    fail = true;
    await instance.reconcile();
    expect(await instance.pending({ scope: 'https://pod.example/alice/' })).toEqual({ trust: 'all', rooms: [] });
    fail = false;
    await instance.reconcile();
    expect((await instance.pending({ scope: 'https://pod.example/alice/' })).trust).toBe('changed');
    instance.stop();
  });

  it('replaces a watcher when the participant identity changes on the same Pod', async () => {
    let routes = [ route('alice.example', 'https://pod.example/shared/') ];
    const { instance, started } = service({ routes: async () => routes });
    await instance.start();
    routes = [ route('bob.example', 'https://pod.example/shared/') ];
    await instance.reconcile();
    expect(started).toHaveLength(2);
    expect(started[0].watch.stopped).toBe(true);
    expect(started[1].route.webId).toBe(routes[0].webId);
    instance.stop();
  });
  it('refreshes existing watches on reconciliation instead of skipping their new topics', async () => {
    const refresh = vi.fn(async () => undefined);
    const { instance } = service({ watch: async input => ({ ...fakeWatch(input), refresh }) });
    await instance.start();
    await instance.reconcile();
    expect(refresh).toHaveBeenCalledTimes(2);
    instance.stop();
  });
  it('watches every served Pod using its own route and room source', async () => {
    const { instance, started } = service();
    await instance.start();

    expect(started.map(entry => entry.route.podUrl).sort())
      .toEqual([ 'https://pod.example/alice/', 'https://pod.example/carol/' ]);
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


});

describe('reporting a Pod that cannot be watched', () => {
  it('reports the same failure once, and forgets it when the Pod goes away', async () => {
    let routes = [ route('alice.example') ];
    const errors: Error[] = [];
    const instance = createMatrixRoomWatchService({
      routes: async () => routes,
      rooms: async () => [],
      intervalMs: 0,
      watch: async () => { throw new Error('the Pod refused a subscription'); },
      onError: error => { errors.push(error); },
    });

    await instance.start();
    await instance.reconcile();
    await instance.reconcile();
    // A log that repeats every pass hides everything else; one report per failure is enough.
    expect(errors.map(error => error.message)).toEqual([ 'the Pod refused a subscription' ]);

    // Once the Pod is no longer served the failure is forgotten, so a later re-appearance is news.
    routes = [];
    await instance.reconcile();
    routes = [ route('alice.example') ];
    await instance.reconcile();
    expect(errors).toHaveLength(2);
  });
});
