import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { P2PSignalingClient } from '../../src/edge/reachability';
import { EdgeNodeAgent } from '../../src/edge/EdgeNodeAgent';

describe('EdgeNodeAgent P2P answer loop', () => {
  let agent: EdgeNodeAgent | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));
  });

  afterEach(() => {
    agent?.stop();
    agent = undefined;
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('polls pending werift P2P sessions and closes answered nodes on stop', async () => {
    const closeFirst = vi.fn(async () => undefined);
    const closeSecond = vi.fn(async () => undefined);
    const signaling = {} as P2PSignalingClient;
    const answerPendingSessionsOnce = vi.fn()
      .mockResolvedValueOnce([
        { close: closeFirst },
        { close: closeSecond },
      ])
      .mockResolvedValue([]);

    agent = new EdgeNodeAgent();
    await agent.start({
      signalEndpoint: 'https://cluster.example/api/signal',
      nodeId: 'node-1',
      nodeToken: 'node-token',
      enableNetworkDetection: false,
      p2p: {
        enabled: true,
        signaling,
        targetBaseUrl: 'http://127.0.0.1:3000/',
        pollIntervalMs: 1_000,
        answerPendingSessionsOnce,
      },
    });

    await vi.waitFor(() => {
      expect(answerPendingSessionsOnce).toHaveBeenCalledTimes(1);
    });
    expect(answerPendingSessionsOnce).toHaveBeenLastCalledWith(expect.objectContaining({
      signaling,
      sourceId: 'node-1',
      targetBaseUrl: 'http://127.0.0.1:3000/',
    }));

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => {
      expect(answerPendingSessionsOnce).toHaveBeenCalledTimes(2);
    });

    agent.stop();
    await vi.waitFor(() => {
      expect(closeFirst).toHaveBeenCalledTimes(1);
      expect(closeSecond).toHaveBeenCalledTimes(1);
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(answerPendingSessionsOnce).toHaveBeenCalledTimes(2);
  });

  it('closes nodes returned by an in-flight P2P poll after stop', async () => {
    const closeNode = vi.fn(async () => undefined);
    const signaling = {} as P2PSignalingClient;
    let resolvePoll!: (handles: Array<{ close(): Promise<void> }>) => void;
    const pollPromise = new Promise<Array<{ close(): Promise<void> }>>((resolve) => {
      resolvePoll = resolve;
    });
    const answerPendingSessionsOnce = vi.fn(() => pollPromise);

    agent = new EdgeNodeAgent();
    await agent.start({
      signalEndpoint: 'https://cluster.example/api/signal',
      nodeId: 'node-1',
      nodeToken: 'node-token',
      enableNetworkDetection: false,
      p2p: {
        enabled: true,
        signaling,
        targetBaseUrl: 'http://127.0.0.1:3000/',
        pollIntervalMs: 1_000,
        answerPendingSessionsOnce,
      },
    });

    await vi.waitFor(() => {
      expect(answerPendingSessionsOnce).toHaveBeenCalledTimes(1);
    });

    agent.stop();
    resolvePoll([{ close: closeNode }]);

    await vi.waitFor(() => {
      expect(closeNode).toHaveBeenCalledTimes(1);
    });
  });


  it('advertises a managed werift p2p route in heartbeat metadata when the answer loop is enabled', async () => {
    const signaling = {} as P2PSignalingClient;
    const answerPendingSessionsOnce = vi.fn().mockResolvedValue([]);

    agent = new EdgeNodeAgent();
    await agent.start({
      signalEndpoint: 'https://cluster.example/api/signal',
      nodeId: 'node-1',
      nodeToken: 'node-token',
      baseUrl: 'https://node-1.pods.example/',
      enableNetworkDetection: false,
      metadata: {
        routes: [{
          id: 'user-tunnel',
          kind: 'user-tunnel',
          targetUrl: 'https://tunnel.example/',
          priority: 50,
          requiresManagedClient: false,
          visibility: 'public',
          health: 'healthy',
        }],
      },
      p2p: {
        enabled: true,
        signaling,
        targetBaseUrl: 'http://127.0.0.1:3000/',
        label: 'xpod-p2p-http',
        answerPendingSessionsOnce,
      },
    });

    await vi.waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(1);
    });
    const [, init] = (fetch as any).mock.calls[0];
    const payload = JSON.parse(init.body);

    expect(payload.metadata.routes).toEqual([
      expect.objectContaining({ id: 'user-tunnel', kind: 'user-tunnel' }),
      expect.objectContaining({
        id: 'p2p-werift-datachannel',
        kind: 'p2p',
        targetUrl: 'webrtc://signaling/node-1',
        priority: 40,
        requiresManagedClient: true,
        visibility: 'authorized-client',
        health: 'healthy',
        metadata: {
          protocols: {
            'werift-datachannel': {
              enabled: true,
              label: 'xpod-p2p-http',
            },
            webrtc: {
              enabled: true,
            },
          },
        },
      }),
    ]);
  });

});
