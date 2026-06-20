import { describe, expect, it, vi } from 'vitest';
import type { AccessRoute, P2PCandidateUpdateRequest, P2PSession, P2PSignalingClient, P2PTransportCandidate } from '../../../src/edge/reachability';
import {
  connectUdpP2PThroughSignaling,
  createP2PDataPlaneFetch,
  createP2PDataPlaneHandler,
  createUdpP2PDataPlaneServer,
  createUdpP2PRendezvousPeer,
} from '../../../src/edge/reachability';

const p2pRoute: AccessRoute = {
  id: 'udp-signaled-session-1',
  nodeId: 'node-1',
  canonicalUrl: 'https://node-1.pods.example/',
  kind: 'p2p',
  targetUrl: 'udp://signaling-session/p2p_1',
  priority: 40,
  requiresManagedClient: true,
  visibility: 'authorized-client',
  health: 'healthy',
};

describe('signaled UDP P2P data plane', () => {
  it('exchanges candidates through signaling before carrying canonical Solid HTTP frames', async () => {
    const signaling = new InMemoryP2PSignalingClient('p2p_1');
    const localFetch = vi.fn(async () => new Response('signaled response', {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    }));
    const nodePeer = createUdpP2PRendezvousPeer({
      sessionId: 'p2p_1',
      role: 'node',
      sourceId: 'node-1',
      host: '127.0.0.1',
      publicHost: '127.0.0.1',
    });
    const clientPeer = createUdpP2PRendezvousPeer({
      sessionId: 'p2p_1',
      role: 'client',
      sourceId: 'device-1',
      host: '127.0.0.1',
      publicHost: '127.0.0.1',
    });
    const nodeServer = createUdpP2PDataPlaneServer({
      socket: nodePeer.socket(),
      handler: createP2PDataPlaneHandler({
        targetBaseUrl: 'http://127.0.0.1:5737/',
        fetchImpl: localFetch as typeof fetch,
      }),
    });
    await nodeServer.listen();

    try {
      const [clientConnection] = await Promise.all([
        connectUdpP2PThroughSignaling({
          signaling,
          sessionId: 'p2p_1',
          role: 'client',
          sourceId: 'device-1',
          peer: clientPeer,
          pollIntervalMs: 10,
          timeoutMs: 1_000,
          rendezvous: { intervalMs: 10, timeoutMs: 1_000 },
        }),
        connectUdpP2PThroughSignaling({
          signaling,
          sessionId: 'p2p_1',
          role: 'node',
          sourceId: 'node-1',
          peer: nodePeer,
          pollIntervalMs: 10,
          timeoutMs: 1_000,
          rendezvous: { intervalMs: 10, timeoutMs: 1_000 },
        }),
      ]);

      const fetchViaP2P = createP2PDataPlaneFetch({
        route: p2pRoute,
        transport: clientConnection.transport,
      });
      const response = await fetchViaP2P('https://node-1.pods.example/alice/signaled.txt', {
        method: 'PUT',
        headers: { authorization: 'DPoP token', 'content-type': 'text/plain' },
        body: 'signaled body',
      });

      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toBe('signaled response');
      expect(signaling.addedCandidates.map((entry) => entry.role)).toEqual(['client', 'node']);
      expect(localFetch).toHaveBeenCalledTimes(1);
      const [targetUrl, init] = localFetch.mock.calls[0];
      expect(targetUrl).toBe('http://127.0.0.1:5737/alice/signaled.txt');
      expect(new Headers(init.headers).get('x-xpod-canonical-url')).toBe('https://node-1.pods.example/alice/signaled.txt');
      clientConnection.close();
    } finally {
      await nodeServer.close();
      await clientPeer.close();
      await nodePeer.close();
    }
  });
});

class InMemoryP2PSignalingClient implements P2PSignalingClient {
  public readonly addedCandidates: P2PCandidateUpdateRequest[] = [];
  private readonly session: P2PSession;

  public constructor(sessionId: string) {
    this.session = {
      sessionId,
      kind: 'p2p',
      nodeId: 'node-1',
      clientId: 'device-1',
      createdAt: '2026-06-20T00:00:00.000Z',
      expiresAt: '2026-06-20T00:05:00.000Z',
      nodeCandidates: [],
      signalingUrl: `https://api.example/v1/signal/nodes/node-1/sessions/${sessionId}`,
      capabilities: ['udp-hole-punch'],
      candidates: [],
    };
  }

  public async createP2PSession(): Promise<P2PSession> {
    return this.clone();
  }

  public async getP2PSession(): Promise<P2PSession> {
    return this.clone();
  }

  public async addP2PCandidates(_sessionId: string, request: P2PCandidateUpdateRequest): Promise<P2PSession> {
    this.addedCandidates.push(request);
    this.session.candidates.push(...request.candidates as P2PTransportCandidate[]);
    return this.clone();
  }

  private clone(): P2PSession {
    return {
      ...this.session,
      candidates: this.session.candidates.map((candidate) => ({ ...candidate })),
    };
  }
}
