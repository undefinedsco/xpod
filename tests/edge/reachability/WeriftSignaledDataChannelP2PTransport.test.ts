import { describe, expect, it, vi } from 'vitest';
import type { RTCIceCandidateInit } from 'werift';
import type { AccessRoute, P2PCandidateUpdateRequest, P2PSession, P2PSignalingClient, P2PTransportCandidate } from '../../../src/edge/reachability';
import {
  connectWeriftDataChannelThroughSignaling,
  createWeriftDataChannelSessionThroughSignaling,
  answerPendingWeriftP2PSessionsOnce,
  createP2PDataPlaneFetch,
  createP2PDataPlaneHandler,
  createWeriftSignaledP2PDataPlaneClient,
  createWeriftSignaledP2PDataPlaneClientFromApi,
  createWeriftSignaledP2PDataPlaneNode,
  createWeriftDataChannelP2PServer,
  createWeriftDataChannelP2PTransport,
  resolveWeriftPeerConfig,
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
  it('derives werift ICE servers from route provider metadata without overriding explicit peer config', () => {
    const session = new InMemoryP2PSignalingClient('p2p_ice_metadata').session;
    session.nodeCandidates = [{
      ...p2pRoute,
      metadata: {
        protocols: {
          'werift-datachannel': {
            iceServers: [
              { urls: 'stun:stun.example.invalid:3478' },
              {
                urls: [
                  'turn:turn.example.invalid:3478?transport=udp',
                  'turns:turn.example.invalid:5349?transport=tcp',
                ],
                username: 'device-user',
                credential: 'device-secret',
              },
            ],
          },
        },
      },
    }];

    const resolved = resolveWeriftPeerConfig({
      iceAdditionalHostAddresses: ['127.0.0.1'],
    }, session);
    const explicit = resolveWeriftPeerConfig({
      iceServers: [{ urls: 'stun:explicit.example.invalid:3478' }],
    }, session);

    expect(resolved.iceAdditionalHostAddresses).toEqual(['127.0.0.1']);
    expect(resolved.iceServers).toEqual([
      { urls: 'stun:stun.example.invalid:3478' },
      {
        urls: 'turn:turn.example.invalid:3478?transport=udp',
        username: 'device-user',
        credential: 'device-secret',
      },
      {
        urls: 'turns:turn.example.invalid:5349?transport=tcp',
        username: 'device-user',
        credential: 'device-secret',
      },
    ]);
    expect(explicit.iceServers).toEqual([{ urls: 'stun:explicit.example.invalid:3478' }]);
  });

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

  it('creates the signaling session before publishing the werift offer', async () => {
    const signaling = new InMemoryP2PSignalingClient('p2p_created');
    signaling.session.nodeCandidates = [p2pRoute];
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
      expect(signaling.addedCandidates.flatMap((entry) => entry.candidates).map((candidate) => (candidate as P2PTransportCandidate).metadata?.signalType)).toEqual(['offer']);
    });
    const createdRequest = signaling.createdSessions[0] as { candidates?: P2PTransportCandidate[] };
    expect(createdRequest.candidates).toEqual([]);
    const [createdOffer] = signaling.addedCandidates.flatMap((entry) => entry.candidates) as P2PTransportCandidate[];
    expect(createdOffer.metadata?.sessionId).toBe('p2p_created');
    expect(createdOffer.url).toBe('webrtc://p2p_created/offer');
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
      expect(signaling.addedCandidates.map((entry) => entry.role)).toEqual(['client', 'node']);
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

  it('provides one-call client and node helpers for canonical Solid HTTP over a signaled werift session', async () => {
    const signaling = new InMemoryP2PSignalingClient('p2p_one_call');
    signaling.session.nodeCandidates = [p2pRoute];
    const peerConfig = {
      iceServers: [],
      iceAdditionalHostAddresses: ['127.0.0.1'],
    };
    const localFetch = vi.fn(async () => new Response('one-call helper response', { status: 211 }));

    const clientPromise = createWeriftSignaledP2PDataPlaneClient({
      signaling,
      sourceId: 'device-1',
      label: 'xpod-p2p-http',
      timeoutMs: 3_000,
      pollIntervalMs: 10,
      peerConfig,
      capabilities: ['webrtc-datachannel'],
      transportTimeoutMs: 2_000,
    });
    await vi.waitFor(() => {
      expect(signaling.createdSessions).toHaveLength(1);
    });
    const nodePromise = createWeriftSignaledP2PDataPlaneNode({
      signaling,
      sessionId: signaling.session.sessionId,
      sourceId: 'node-1',
      targetBaseUrl: 'http://127.0.0.1:5737/',
      label: 'xpod-p2p-http',
      timeoutMs: 3_000,
      pollIntervalMs: 10,
      peerConfig,
      fetchImpl: localFetch as typeof fetch,
    });

    const [client, node] = await Promise.all([clientPromise, nodePromise]);
    try {
      const response = await client.fetch('https://node-1.pods.example/alice/one-call.txt', {
        method: 'PATCH',
        headers: { authorization: 'DPoP token', 'content-type': 'application/sparql-update' },
        body: 'INSERT DATA {}',
      });

      expect(client.session.sessionId).toBe('p2p_one_call');
      expect(client.route).toEqual(p2pRoute);
      expect(response.status).toBe(211);
      await expect(response.text()).resolves.toBe('one-call helper response');
      expect(localFetch).toHaveBeenCalledTimes(1);
      const [targetUrl, init] = localFetch.mock.calls[0];
      expect(targetUrl).toBe('http://127.0.0.1:5737/alice/one-call.txt');
      const headers = new Headers(init.headers);
      expect(headers.get('authorization')).toBe('DPoP token');
      expect(headers.get('x-xpod-canonical-url')).toBe('https://node-1.pods.example/alice/one-call.txt');
    } finally {
      await Promise.allSettled([client.close(), node.close()]);
    }
  });


  it('creates a one-call client from signaling API options for native callers', async () => {
    const signaling = new InMemoryP2PSignalingClient('p2p_api_helper');
    signaling.session.nodeCandidates = [p2pRoute];
    const peerConfig = {
      iceServers: [],
      iceAdditionalHostAddresses: ['127.0.0.1'],
    };
    const signalingFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input.toString());
      const body = typeof init?.body === 'string' && init.body.length > 0
        ? JSON.parse(init.body)
        : undefined;
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe('Bearer managed-client-token');
      if (url.pathname === '/v1/signal/nodes/node-1/sessions' && init?.method === 'POST') {
        const session = await signaling.createP2PSession(body);
        return new Response(JSON.stringify(session), { status: 201, headers: { 'content-type': 'application/json' } });
      }
      if (url.pathname === '/v1/signal/nodes/node-1/sessions/p2p_api_helper') {
        const session = await signaling.getP2PSession('p2p_api_helper');
        return new Response(JSON.stringify(session), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.pathname === '/v1/signal/nodes/node-1/sessions/p2p_api_helper/candidates' && init?.method === 'POST') {
        const session = await signaling.addP2PCandidates('p2p_api_helper', body);
        return new Response(JSON.stringify(session), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('not found', { status: 404 });
    });
    const localFetch = vi.fn(async () => new Response('api-helper response', { status: 212 }));

    const clientPromise = createWeriftSignaledP2PDataPlaneClientFromApi({
      apiBaseUrl: 'https://api.example/',
      nodeId: 'node-1',
      token: 'managed-client-token',
      signalingFetchImpl: signalingFetch as typeof fetch,
      sourceId: 'device-1',
      label: 'xpod-p2p-http',
      timeoutMs: 3_000,
      pollIntervalMs: 10,
      peerConfig,
      capabilities: ['webrtc-datachannel'],
      transportTimeoutMs: 2_000,
    });
    await vi.waitFor(() => {
      expect(signaling.createdSessions).toHaveLength(1);
    });
    const nodePromise = createWeriftSignaledP2PDataPlaneNode({
      signaling,
      sessionId: signaling.session.sessionId,
      sourceId: 'node-1',
      targetBaseUrl: 'http://127.0.0.1:5737/',
      label: 'xpod-p2p-http',
      timeoutMs: 3_000,
      pollIntervalMs: 10,
      peerConfig,
      fetchImpl: localFetch as typeof fetch,
    });

    const [client, node] = await Promise.all([clientPromise, nodePromise]);
    try {
      const response = await client.fetch('https://node-1.pods.example/alice/api-helper.txt');

      expect(client.session.sessionId).toBe('p2p_api_helper');
      expect(client.route).toEqual(p2pRoute);
      expect(response.status).toBe(212);
      await expect(response.text()).resolves.toBe('api-helper response');
      expect(signalingFetch).toHaveBeenCalledWith(
        'https://api.example/v1/signal/nodes/node-1/sessions',
        expect.objectContaining({ method: 'POST' }),
      );
      expect(signaling.createdSessions[0]).toMatchObject({
        clientId: 'device-1',
        capabilities: ['webrtc-datachannel'],
      });
      expect(localFetch).toHaveBeenCalledTimes(1);
    } finally {
      await Promise.allSettled([client.close(), node.close()]);
    }
  });

  it('lets node agents answer only pending werift offers discovered from the signaling session list', async () => {
    const pending = new InMemoryP2PSignalingClient('p2p_pending');
    pending.session.candidates.push({
      id: 'offer-1',
      role: 'client',
      sourceId: 'device-1',
      createdAt: '2026-06-20T00:00:00.000Z',
      protocol: 'webrtc',
      transport: 'datachannel',
      url: 'webrtc://offer',
      metadata: { provider: 'werift-datachannel', signalType: 'offer', sdp: 'offer-sdp' },
    });
    const alreadyAnswered = new InMemoryP2PSignalingClient('p2p_answered').session;
    alreadyAnswered.candidates.push(
      {
        id: 'offer-2',
        role: 'client',
        sourceId: 'device-1',
        createdAt: '2026-06-20T00:00:00.000Z',
        protocol: 'webrtc',
        transport: 'datachannel',
        url: 'webrtc://offer',
        metadata: { provider: 'werift-datachannel', signalType: 'offer', sdp: 'offer-sdp' },
      },
      {
        id: 'answer-2',
        role: 'node',
        sourceId: 'node-1',
        createdAt: '2026-06-20T00:00:01.000Z',
        protocol: 'webrtc',
        transport: 'datachannel',
        url: 'webrtc://answer',
        metadata: { provider: 'werift-datachannel', signalType: 'answer', sdp: 'answer-sdp' },
      },
    );
    const unrelated = new InMemoryP2PSignalingClient('p2p_unrelated').session;
    unrelated.candidates.push({
      id: 'udp-1',
      role: 'client',
      sourceId: 'device-1',
      createdAt: '2026-06-20T00:00:00.000Z',
      protocol: 'udp',
      transport: 'udp',
      host: '127.0.0.1',
      port: 41000,
    });
    const signaling = new MultiSessionP2PSignalingClient([
      pending.session,
      alreadyAnswered,
      unrelated,
    ]);
    const createNode = vi.fn(async (options: any) => ({
      sessionId: options.sessionId,
      close: vi.fn(async () => undefined),
    }));

    const nodes = await answerPendingWeriftP2PSessionsOnce({
      signaling,
      sourceId: 'node-1',
      targetBaseUrl: 'http://127.0.0.1:5737/',
      createNode,
    });

    expect(nodes).toEqual([expect.objectContaining({ sessionId: 'p2p_pending' })]);
    expect(createNode).toHaveBeenCalledTimes(1);
    expect(createNode).toHaveBeenCalledWith(expect.objectContaining({
      signaling,
      sessionId: 'p2p_pending',
      sourceId: 'node-1',
      targetBaseUrl: 'http://127.0.0.1:5737/',
    }));
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

class MultiSessionP2PSignalingClient implements P2PSignalingClient {
  public constructor(private readonly sessions: P2PSession[]) {}

  public async createP2PSession(): Promise<P2PSession> {
    throw new Error('not used');
  }

  public async listP2PSessions(): Promise<P2PSession[]> {
    return this.sessions.map((session) => cloneJson(session));
  }

  public async getP2PSession(sessionId: string): Promise<P2PSession> {
    const session = this.sessions.find((candidate) => candidate.sessionId === sessionId);
    if (!session) {
      throw new Error(`missing session ${sessionId}`);
    }
    return cloneJson(session);
  }

  public async addP2PCandidates(): Promise<P2PSession> {
    throw new Error('not used');
  }
}

function cloneJson<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}
