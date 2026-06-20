import { describe, expect, it, vi } from 'vitest';
import type { RTCIceCandidateInit } from 'werift';
import type { AccessRoute, P2PCandidateUpdateRequest, P2PSession, P2PSignalingClient, P2PTransportCandidate } from '../../../src/edge/reachability';
import {
  connectWeriftDataChannelThroughSignaling,
  createWeriftDataChannelSessionThroughSignaling,
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

  it('lets the client create the signaling session with an initial werift offer before the node answers', async () => {
    const signaling = new InMemoryP2PSignalingClient('p2p_created');
    const peerConfig = {
      iceServers: [],
      iceAdditionalHostAddresses: ['127.0.0.1'],
    };
    const localFetch = vi.fn(async () => new Response('created-session response', { status: 210 }));

    const clientPromise = createWeriftDataChannelSessionThroughSignaling({
      signaling,
      sourceId: 'device-1',
      label: 'xpod-p2p-http',
      timeoutMs: 3_000,
      pollIntervalMs: 10,
      peerConfig,
      capabilities: ['webrtc-datachannel'],
    });
    await vi.waitFor(() => {
      expect(signaling.createdSessions).toHaveLength(1);
      expect(signaling.session.candidates.map((candidate) => candidate.metadata?.signalType)).toEqual(['offer']);
    });
    const createdOffer = signaling.createdSessions[0] as { candidates: P2PTransportCandidate[] };
    expect(createdOffer.candidates[0].metadata?.sessionId).toBeUndefined();
    expect(createdOffer.candidates[0].url).toBe('webrtc://offer');
    const nodeConnectionPromise = connectWeriftDataChannelThroughSignaling({
      signaling,
      sessionId: signaling.session.sessionId,
      role: 'node',
      sourceId: 'node-1',
      label: 'xpod-p2p-http',
      timeoutMs: 3_000,
      pollIntervalMs: 10,
      peerConfig,
    });
    const [clientConnection, nodeConnection] = await Promise.all([clientPromise, nodeConnectionPromise]);
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
      expect(clientConnection.session.sessionId).toBe('p2p_created');
      expect(signaling.createdSessions[0]).toMatchObject({
        clientId: 'device-1',
        capabilities: ['webrtc-datachannel'],
      });
      expect(signaling.addedCandidates.map((entry) => entry.role)).toEqual(['node']);
      const fetchViaP2P = createP2PDataPlaneFetch({ route: p2pRoute, transport });
      const response = await fetchViaP2P('https://node-1.pods.example/alice/created-session.txt');

      expect(response.status).toBe(210);
      await expect(response.text()).resolves.toBe('created-session response');
      expect(localFetch).toHaveBeenCalledTimes(1);
    } finally {
      transport.close();
      server.close();
      await Promise.allSettled([clientConnection.close(), nodeConnection.close()]);
    }
  });

  it('trickles local ICE candidates through signaling after the DataChannel is open', async () => {
    const signaling = new InMemoryP2PSignalingClient('p2p_trickle');
    const peerConfig = {
      iceServers: [],
      iceAdditionalHostAddresses: ['127.0.0.1'],
    };

    const [clientConnection, nodeConnection] = await Promise.all([
      connectWeriftDataChannelThroughSignaling({
        signaling,
        sessionId: 'p2p_trickle',
        role: 'client',
        sourceId: 'device-1',
        timeoutMs: 3_000,
        pollIntervalMs: 10,
        peerConfig,
      }),
      connectWeriftDataChannelThroughSignaling({
        signaling,
        sessionId: 'p2p_trickle',
        role: 'node',
        sourceId: 'node-1',
        timeoutMs: 3_000,
        pollIntervalMs: 10,
        peerConfig,
      }),
    ]);
    const addIceCandidate = vi.spyOn(nodeConnection.peer, 'addIceCandidate').mockResolvedValue(undefined);
    const trickledCandidate: RTCIceCandidateInit = {
      candidate: 'candidate:842163049 1 udp 1677729535 203.0.113.10 54321 typ srflx raddr 10.0.0.2 rport 5000',
      sdpMid: '0',
      sdpMLineIndex: 0,
      usernameFragment: 'client-ufrag',
    };

    try {
      clientConnection.peer.onIceCandidate.execute(trickledCandidate);

      await vi.waitFor(() => {
        const trickledSignals = signaling.addedCandidates
          .flatMap((entry) => entry.candidates as P2PTransportCandidate[])
          .filter((candidate) => candidate.metadata?.signalType === 'ice-candidate');
        expect(trickledSignals).toHaveLength(1);
        expect(trickledSignals[0]).toMatchObject({
          role: 'client',
          sourceId: 'device-1',
          protocol: 'webrtc',
          transport: 'datachannel',
          metadata: {
            provider: 'werift-datachannel',
            sessionId: 'p2p_trickle',
            candidate: trickledCandidate,
          },
        });
      });
      await vi.waitFor(() => {
        expect(addIceCandidate).toHaveBeenCalledWith(trickledCandidate);
      });
    } finally {
      addIceCandidate.mockRestore();
      await Promise.allSettled([clientConnection.close(), nodeConnection.close()]);
    }
  });

});

class InMemoryP2PSignalingClient implements P2PSignalingClient {
  public readonly addedCandidates: P2PCandidateUpdateRequest[] = [];
  public readonly createdSessions: unknown[] = [];
  public readonly session: P2PSession;

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

  public async createP2PSession(request?: unknown): Promise<P2PSession> {
    const clonedRequest = cloneJson(request);
    this.createdSessions.push(clonedRequest);
    const typedRequest = clonedRequest as { clientId?: string; capabilities?: string[]; candidates?: P2PTransportCandidate[] } | undefined;
    if (typedRequest?.clientId) {
      this.session.clientId = typedRequest.clientId;
    }
    if (typedRequest?.capabilities) {
      this.session.capabilities = typedRequest.capabilities;
    }
    if (typedRequest?.candidates) {
      this.session.candidates.push(...typedRequest.candidates);
    }
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


function cloneJson<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}
