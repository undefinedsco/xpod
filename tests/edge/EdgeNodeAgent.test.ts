import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EdgeNodeAgent } from '../../src/edge/EdgeNodeAgent';

describe('EdgeNodeAgent P2P raw TCP route advertisement', () => {
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

  it('advertises a managed raw TCP p2p route in heartbeat metadata when p2p is enabled', async () => {
    agent = new EdgeNodeAgent();
    await agent.start({
      signalEndpoint: 'https://cluster.example/api/signal',
      nodeId: 'node-1',
      nodeToken: 'node-token',
      baseUrl: 'https://node-1.pods.example/',
      enableNetworkDetection: false,
      metadata: {
        routes: [
          {
            id: 'user-tunnel',
            kind: 'user-tunnel',
            targetUrl: 'https://tunnel.example/',
            priority: 50,
            requiresManagedClient: false,
            visibility: 'public',
            health: 'healthy',
          },
        ],
      },
      p2p: {
        enabled: true,
        targetBaseUrl: 'http://127.0.0.1:3000/',
        label: 'xpod-p2p-http',
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
        id: 'p2p-raw-tcp',
        nodeId: 'node-1',
        canonicalUrl: 'https://node-1.pods.example/',
        kind: 'p2p',
        targetUrl: 'tcp-punch://node/node-1',
        priority: 40,
        requiresManagedClient: true,
        visibility: 'authorized-client',
        health: 'healthy',
        metadata: {
          protocols: {
            'raw-tcp-hole-punch': {
              enabled: true,
              label: 'xpod-p2p-http',
            },
          },
        },
      }),
    ]);
  });

  it('does not advertise a p2p route when p2p is explicitly disabled', async () => {
    agent = new EdgeNodeAgent();
    await agent.start({
      signalEndpoint: 'https://cluster.example/api/signal',
      nodeId: 'node-1',
      nodeToken: 'node-token',
      enableNetworkDetection: false,
      p2p: {
        enabled: 'false',
        targetBaseUrl: 'http://127.0.0.1:3000/',
      },
    });

    await vi.waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(1);
    });
    const [, init] = (fetch as any).mock.calls[0];
    const payload = JSON.parse(init.body);

    expect(payload.metadata?.routes).toBeUndefined();
  });
});
