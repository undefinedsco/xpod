import { describe, expect, it, vi } from 'vitest';
import type { AccessRoute } from '../../../src/edge/reachability';
import {
  computeTcpHolePunchPlan,
  createP2PDataPlaneFetch,
  createP2PDataPlaneHandler,
  createTcpP2PDataPlaneServer,
  createTcpP2PDataPlaneTransport,
} from '../../../src/edge/reachability';

const p2pRoute: AccessRoute = {
  id: 'tcp-p2p-session-1',
  nodeId: 'node-1',
  canonicalUrl: 'https://node-1.pods.example/',
  kind: 'p2p',
  targetUrl: 'tcp-punch://node-1/session-1',
  priority: 40,
  requiresManagedClient: true,
  visibility: 'authorized-client',
  health: 'healthy',
};

describe('TCP P2P data plane transport', () => {
  it('round-trips canonical Solid HTTP frames over a real TCP stream', async () => {
    const localFetch = vi.fn(async () => new Response('tcp local response', {
      status: 207,
      statusText: 'Multi-Status',
      headers: {
        'content-type': 'text/plain',
        etag: '"tcp"',
      },
    }));
    const handler = createP2PDataPlaneHandler({
      targetBaseUrl: 'http://127.0.0.1:5737/',
      fetchImpl: localFetch as typeof fetch,
    });
    const server = createTcpP2PDataPlaneServer({ handler, host: '127.0.0.1' });
    await server.listen(0);

    try {
      const address = server.address();
      const transport = createTcpP2PDataPlaneTransport({
        remoteHost: '127.0.0.1',
        remotePort: address.port,
        timeoutMs: 2_000,
        randomId: () => 'tcp-request',
      });
      const fetchViaP2P = createP2PDataPlaneFetch({ route: p2pRoute, transport });

      const response = await fetchViaP2P('https://node-1.pods.example/alice/tcp.txt?via=raw', {
        method: 'PUT',
        headers: {
          authorization: 'DPoP token',
          'content-type': 'text/plain',
        },
        body: 'hello tcp p2p',
      });

      expect(response.status).toBe(207);
      expect(response.statusText).toBe('Multi-Status');
      expect(response.headers.get('etag')).toBe('"tcp"');
      await expect(response.text()).resolves.toBe('tcp local response');
      expect(localFetch).toHaveBeenCalledTimes(1);
      const [targetUrl, init] = localFetch.mock.calls[0];
      expect(targetUrl).toBe('http://127.0.0.1:5737/alice/tcp.txt?via=raw');
      const headers = new Headers(init.headers);
      expect(headers.get('authorization')).toBe('DPoP token');
      expect(headers.get('x-xpod-canonical-url')).toBe('https://node-1.pods.example/alice/tcp.txt?via=raw');
      expect(init.body).toEqual(Buffer.from('hello tcp p2p'));
      transport.close();
    } finally {
      await server.close();
    }
  });

  it('computes deterministic raw TCP hole-punch buckets, rendezvous time, and candidate ports', () => {
    const plan = computeTcpHolePunchPlan({
      nowSeconds: 1_000,
      windowSeconds: 42,
      maxClockErrorSeconds: 20,
      minRunWindowSeconds: 10,
      numPorts: 6,
      basePort: 30_000,
      portRange: 20_000,
    });
    const samePlan = computeTcpHolePunchPlan({
      nowSeconds: 1_006,
      windowSeconds: 42,
      maxClockErrorSeconds: 20,
      minRunWindowSeconds: 10,
      numPorts: 6,
      basePort: 30_000,
      portRange: 20_000,
    });

    expect(plan.bucket).toBe(samePlan.bucket);
    expect(plan.boundary).toBe(samePlan.boundary);
    expect(plan.ports).toEqual(samePlan.ports);
    expect(plan.rendezvousTimeSeconds).toBeGreaterThanOrEqual(1_000 + 10);
    expect(plan.ports).toHaveLength(6);
    expect(new Set(plan.ports).size).toBe(6);
    expect(plan.ports.every((port) => port >= 30_000 && port < 50_000)).toBe(true);
  });

  it('skips to the next bucket when there is not enough setup time before rendezvous', () => {
    const nearBoundary = computeTcpHolePunchPlan({
      nowSeconds: 1_065,
      windowSeconds: 42,
      maxClockErrorSeconds: 20,
      minRunWindowSeconds: 10,
      numPorts: 4,
      basePort: 30_000,
      portRange: 20_000,
    });

    expect(nearBoundary.rendezvousTimeSeconds - 1_065).toBeGreaterThanOrEqual(10);
    expect(nearBoundary.bucket).toBe(Math.floor((1_065 - 20) / 42) + 1);
  });
});
