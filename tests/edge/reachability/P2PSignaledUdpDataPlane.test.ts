import { createSocket, type RemoteInfo, type Socket } from 'node:dgram';
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

  it('publishes STUN server-reflexive candidates with the same rendezvous socket', async () => {
    const signaling = new InMemoryP2PSignalingClient('p2p_1');
    const stunServer = await createFakeStunServer({
      mappedHost: '203.0.113.77',
      mappedPort: 45221,
    });
    const peer = createUdpP2PRendezvousPeer({
      sessionId: 'p2p_1',
      role: 'client',
      sourceId: 'device-1',
      host: '127.0.0.1',
      publicHost: '127.0.0.1',
    });

    try {
      await expect(connectUdpP2PThroughSignaling({
        signaling,
        sessionId: 'p2p_1',
        role: 'client',
        sourceId: 'device-1',
        peer,
        stunServers: [{ host: '127.0.0.1', port: stunServer.port }],
        timeoutMs: 50,
        pollIntervalMs: 10,
      })).rejects.toThrow('Timed out waiting for remote P2P candidates');

      const [published] = signaling.addedCandidates;
      expect(published.candidates).toEqual([
        expect.objectContaining({
          host: '127.0.0.1',
          metadata: expect.objectContaining({ provider: 'udp-direct' }),
        }),
        expect.objectContaining({
          host: '203.0.113.77',
          port: 45221,
          metadata: expect.objectContaining({
            provider: 'stun',
            candidateType: 'server-reflexive',
            sessionId: 'p2p_1',
          }),
        }),
      ]);
      expect(stunServer.lastRequestFrom?.port).toBe((peer.socket().address() as { port: number }).port);
    } finally {
      await peer.close();
      await stunServer.close();
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

const MAGIC_COOKIE = 0x2112A442;

async function createFakeStunServer(options: {
  mappedHost: string;
  mappedPort: number;
}): Promise<{
  port: number;
  lastRequestFrom?: RemoteInfo;
  close(): Promise<void>;
}> {
  const socket = createSocket('udp4');
  const server = {
    port: 0,
    lastRequestFrom: undefined as RemoteInfo | undefined,
    close: async () => {
      await close(socket);
    },
  };
  socket.on('message', (message, remote) => {
    server.lastRequestFrom = remote;
    const transactionId = message.subarray(8, 20);
    const response = buildBindingSuccessResponse(transactionId, options.mappedHost, options.mappedPort);
    socket.send(response, remote.port, remote.address);
  });
  await bind(socket, 0, '127.0.0.1');
  server.port = (socket.address() as { port: number }).port;
  return server;
}

function buildBindingSuccessResponse(transactionId: Buffer, mappedHost: string, mappedPort: number): Buffer {
  const attribute = Buffer.alloc(12);
  attribute.writeUInt16BE(0x0020, 0);
  attribute.writeUInt16BE(8, 2);
  attribute.writeUInt8(0, 4);
  attribute.writeUInt8(0x01, 5);
  attribute.writeUInt16BE(mappedPort ^ (MAGIC_COOKIE >>> 16), 6);
  const addressParts = mappedHost.split('.').map((part) => Number(part));
  for (let index = 0; index < 4; index += 1) {
    attribute[8 + index] = addressParts[index] ^ ((MAGIC_COOKIE >>> (24 - index * 8)) & 0xff);
  }

  const response = Buffer.alloc(20 + attribute.length);
  response.writeUInt16BE(0x0101, 0);
  response.writeUInt16BE(attribute.length, 2);
  response.writeUInt32BE(MAGIC_COOKIE, 4);
  transactionId.copy(response, 8);
  attribute.copy(response, 20);
  return response;
}

async function bind(socket: Socket, port: number, host: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    socket.once('listening', resolve);
    socket.once('error', reject);
    socket.bind(port, host);
  });
}

async function close(socket: Socket): Promise<void> {
  await new Promise<void>((resolve) => {
    socket.close(() => resolve());
  });
}
