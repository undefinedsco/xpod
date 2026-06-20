import { describe, expect, it, vi } from 'vitest';
import type { AccessRoute, P2PCandidateUpdateRequest, P2PSession, P2PSignalingClient, P2PTransportCandidate } from '../../../src/edge/reachability';
import {
  connectWeriftDataChannelThroughSignaling,
  createP2PDataPlaneFetch,
  createP2PDataPlaneHandler,
  createWeriftDataChannelP2PServer,
  createWeriftDataChannelP2PTransport,
} from '../../../src/edge/reachability';

const p2pRoute: AccessRoute = {
  id: 'werift-signaled-session-1',
  nodeId: 'node-1',
  canonicalUrl: 'https://node-1.pods.example/',
  kind: 'p2p',
  targetUrl: 'webrtc://signaling-session/p2p_1',
  priority: 40,
  requiresManagedClient: true,
  visibility: 'authorized-client',
  health: 'healthy',
};

describe('signaled werift DataChannel P2P data plane', () => {
  it('exchanges offer and answer through signaling before carrying canonical Solid HTTP frames', async () => {
    const signaling = new InMemoryP2PSignalingClient('p2p_1');
    const peerConfig = {
      iceServers: [],
      iceAdditionalHostAddresses: ['127.0.0.1'],
    };
    const localFetch = vi.fn(async () => new Response('signaled werift response', {
      status: 209,
      statusText: 'Content Returned',
      headers: { 'content-type': 'text/plain' },
    }));

    const [clientConnection, nodeConnection] = await Promise.all([
      connectWeriftDataChannelThroughSignaling({
        signaling,
        sessionId: 'p2p_1',
        role: 'client',
        sourceId: 'device-1',
        label: 'xpod-p2p-http',
        timeoutMs: 3_000,
        pollIntervalMs: 10,
        peerConfig,
      }),
      connectWeriftDataChannelThroughSignaling({
        signaling,
        sessionId: 'p2p_1',
        role: 'node',
        sourceId: 'node-1',
        label: 'xpod-p2p-http',
        timeoutMs: 3_000,
        pollIntervalMs: 10,
        peerConfig,
      }),
    ]);
    const server = createWeriftDataChannelP2PServer({
      channel: nodeConnection.channel,
      handler: createP2PDataPlaneHandler({
        targetBaseUrl: 'http://127.0.0.1:5737/',
        fetchImpl: localFetch as typeof fetch,
      }),
    });
    const transport = createWeriftDataChannelP2PTransport({
      channel: clientConnection.channel,
      timeoutMs: 2_000,
    });

    try {
      const fetchViaP2P = createP2PDataPlaneFetch({ route: p2pRoute, transport });
      const response = await fetchViaP2P('https://node-1.pods.example/alice/signaled-datachannel.txt', {
        method: 'PUT',
        headers: { authorization: 'DPoP token', 'content-type': 'text/plain' },
        body: 'signaled werift body',
      });

      expect(response.status).toBe(209);
      await expect(response.text()).resolves.toBe('signaled werift response');
      expect(signaling.addedCandidates.map((entry) => entry.role)).toEqual(['client', 'node']);
      expect(signaling.addedCandidates.flatMap((entry) => entry.candidates).map((candidate) => (candidate as P2PTransportCandidate).metadata?.signalType)).toEqual(['offer', 'answer']);
      expect(localFetch).toHaveBeenCalledTimes(1);
      const [targetUrl, init] = localFetch.mock.calls[0];
      expect(targetUrl).toBe('http://127.0.0.1:5737/alice/signaled-datachannel.txt');
      expect(new Headers(init.headers).get('x-xpod-canonical-url')).toBe('https://node-1.pods.example/alice/signaled-datachannel.txt');
    } finally {
      transport.close();
      server.close();
      await Promise.allSettled([clientConnection.close(), nodeConnection.close()]);
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
      capabilities: ['webrtc-datachannel'],
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
      candidates: this.session.candidates.map((candidate) => ({
        ...candidate,
        metadata: candidate.metadata ? { ...candidate.metadata } : undefined,
      })),
    };
  }
}
