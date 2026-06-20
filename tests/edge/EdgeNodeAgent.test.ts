import { createConnection, createServer, type AddressInfo, type Socket } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccessRoute, P2PSession, P2PSignalingClient, P2PTransportCandidate, RawTcpP2PConnectAttempt } from '../../src/edge/reachability';
import {
  createP2PDataPlaneFetch,
  createRawTcpHolePunchCandidates,
  createTcpP2PDataPlaneTransport,
} from '../../src/edge/reachability';
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
    const signaling: P2PSignalingClient = {
      createP2PSession: vi.fn(),
      listP2PSessions: vi.fn(async () => []),
      getP2PSession: vi.fn(),
      addP2PCandidates: vi.fn(),
    };
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
        signaling,
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

  it('starts a node-side raw TCP P2P accept loop when p2p is enabled', async () => {
    const signalingCalls: string[] = [];
    const signaling: P2PSignalingClient = {
      createP2PSession: vi.fn(),
      listP2PSessions: vi.fn(async () => {
        signalingCalls.push('list');
        return [];
      }),
      getP2PSession: vi.fn(),
      addP2PCandidates: vi.fn(),
    };
    agent = new EdgeNodeAgent();
    await agent.start({
      signalEndpoint: 'https://cluster.example/api/signal',
      nodeId: 'node-1',
      nodeToken: 'node-token',
      baseUrl: 'https://node-1.pods.example/',
      enableNetworkDetection: false,
      p2p: {
        enabled: true,
        targetBaseUrl: 'http://127.0.0.1:3000/',
        signaling,
        acceptIntervalMs: 1_000,
      },
    });

    await vi.waitFor(() => {
      expect(signaling.listP2PSessions).toHaveBeenCalledTimes(1);
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => {
      expect(signaling.listP2PSessions).toHaveBeenCalledTimes(2);
    });

    expect(signalingCalls).toEqual(['list', 'list']);
  });


  it('attaches accepted raw TCP P2P sockets to the configured local target base URL', async () => {
    vi.useRealTimers();
    const { clientSocket, serverSocket, close } = await createSocketPair();
    const localPort = await reserveTcpPort();
    const plan = {
      bucket: 205,
      boundary: 777,
      rendezvousTimeSeconds: 0,
      ports: [localPort],
    };
    const clientCandidates = createRawTcpHolePunchCandidates({
      role: 'client',
      sourceId: 'device-1',
      host: '127.0.0.1',
      plan,
    });
    const session: P2PSession = {
      sessionId: 'p2p_agent_loop',
      kind: 'p2p',
      nodeId: 'node-1',
      clientId: 'device-1',
      createdAt: new Date(0).toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      auditId: 'audit-agent-loop',
      nodeCandidates: [p2pRoute],
      signalingUrl: 'https://cluster.example/v1/signal/nodes/node-1/sessions/p2p_agent_loop',
      capabilities: ['tcp-punch'],
      candidates: clientCandidates,
    };
    let listed = false;
    let updatedSession: P2PSession | undefined;
    const signaling: P2PSignalingClient = {
      createP2PSession: vi.fn(),
      listP2PSessions: vi.fn(async () => {
        if (listed) {
          return [];
        }
        listed = true;
        return [session];
      }),
      getP2PSession: vi.fn(),
      addP2PCandidates: vi.fn(async (_sessionIdOrUrl, request) => {
        updatedSession = {
          ...session,
          candidates: [...clientCandidates, ...(request.candidates as P2PTransportCandidate[])],
        };
        return updatedSession;
      }),
    };
    const attempts: RawTcpP2PConnectAttempt[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url === 'https://cluster.example/api/signal') {
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url === 'http://127.0.0.1:3000/alice/agent-loop.txt') {
        return new Response('agent loop response', { status: 200, headers: { 'content-type': 'text/plain' } });
      }
      return new Response(`unexpected fetch ${url}`, { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock);
    agent = new EdgeNodeAgent();

    try {
      await agent.start({
        signalEndpoint: 'https://cluster.example/api/signal',
        nodeId: 'node-1',
        nodeToken: 'node-token',
        baseUrl: 'https://node-1.pods.example/',
        enableNetworkDetection: false,
        p2p: {
          enabled: true,
          targetBaseUrl: 'http://127.0.0.1:3000/',
          host: '127.0.0.1',
          signaling,
          acceptIntervalMs: 1_000,
          connectSocket: async (attempt) => {
            attempts.push(attempt);
            return serverSocket;
          },
        },
      });
      await vi.waitFor(() => {
        expect(signaling.addP2PCandidates).toHaveBeenCalledTimes(1);
      });
      const clientTransport = createTcpP2PDataPlaneTransport({
        remoteHost: '127.0.0.1',
        remotePort: localPort,
        socket: clientSocket,
        timeoutMs: 2_000,
      });
      const fetchViaP2P = createP2PDataPlaneFetch({ route: p2pRoute, transport: clientTransport });

      const response = await fetchViaP2P('https://node-1.pods.example/alice/agent-loop.txt');

      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toBe('agent loop response');
      expect(updatedSession?.candidates.filter((candidate) => candidate.role === 'node')).toEqual([
        expect.objectContaining({ sourceId: 'node-1', host: '127.0.0.1', port: localPort }),
      ]);
      expect(attempts).toEqual([
        expect.objectContaining({
          local: expect.objectContaining({ sourceId: 'node-1', port: localPort }),
          remote: expect.objectContaining({ sourceId: 'device-1', port: localPort }),
        }),
      ]);
      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:3000/alice/agent-loop.txt',
        expect.objectContaining({ method: 'GET' }),
      );
      clientTransport.close();
    } finally {
      await close();
    }
  });

  it('applies the configured raw TCP winner selection window on the node-side accept loop', async () => {
    vi.useRealTimers();
    const wrongPair = await createSocketPair();
    const winnerPair = await createSocketPair();
    const wrongRemotePort = 45_000;
    const winningRemotePort = 44_000;
    const plan = {
      bucket: 206,
      boundary: 777,
      rendezvousTimeSeconds: 0,
      ports: [wrongRemotePort, winningRemotePort],
    };
    const clientCandidates = createRawTcpHolePunchCandidates({
      role: 'client',
      sourceId: 'device-1',
      host: '127.0.0.1',
      plan,
    });
    const session: P2PSession = {
      sessionId: 'p2p_agent_winner',
      kind: 'p2p',
      nodeId: 'node-1',
      clientId: 'device-1',
      createdAt: new Date(0).toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      auditId: 'audit-agent-winner',
      nodeCandidates: [p2pRoute],
      signalingUrl: 'https://cluster.example/v1/signal/nodes/node-1/sessions/p2p_agent_winner',
      capabilities: ['tcp-punch'],
      candidates: clientCandidates,
    };
    let listed = false;
    let updatedSession: P2PSession | undefined;
    const signaling: P2PSignalingClient = {
      createP2PSession: vi.fn(),
      listP2PSessions: vi.fn(async () => {
        if (listed) {
          return [];
        }
        listed = true;
        return [session];
      }),
      getP2PSession: vi.fn(),
      addP2PCandidates: vi.fn(async (_sessionIdOrUrl, request) => {
        updatedSession = {
          ...session,
          candidates: [...clientCandidates, ...(request.candidates as P2PTransportCandidate[])],
        };
        return updatedSession;
      }),
    };
    const attempts: RawTcpP2PConnectAttempt[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url === 'https://cluster.example/api/signal') {
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url === 'http://127.0.0.1:3000/alice/agent-winner.txt') {
        return new Response('node-side deterministic winner', {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        });
      }
      return new Response(`unexpected fetch ${url}`, { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock);
    agent = new EdgeNodeAgent();

    try {
      await agent.start({
        signalEndpoint: 'https://cluster.example/api/signal',
        nodeId: 'node-1',
        nodeToken: 'node-token',
        baseUrl: 'https://node-1.pods.example/',
        enableNetworkDetection: false,
        p2p: {
          enabled: true,
          targetBaseUrl: 'http://127.0.0.1:3000/',
          host: '127.0.0.1',
          signaling,
          acceptIntervalMs: 1_000,
          winnerSelectionWindowMs: 20,
          connectSocket: async (attempt) => {
            attempts.push(attempt);
            if (attempt.localPort === wrongRemotePort && attempt.remotePort === wrongRemotePort) {
              return wrongPair.serverSocket;
            }
            if (attempt.localPort === winningRemotePort && attempt.remotePort === winningRemotePort) {
              await sleepTest(5);
              return winnerPair.serverSocket;
            }
            throw new Error(`unhandled raw TCP attempt ${attempt.localPort}->${attempt.remotePort}`);
          },
        },
      });
      await vi.waitFor(() => {
        expect(signaling.addP2PCandidates).toHaveBeenCalledTimes(1);
      });
      await vi.waitFor(() => {
        expect(attempts.some((attempt) => (
          attempt.localPort === winningRemotePort && attempt.remotePort === winningRemotePort
        ))).toBe(true);
      });
      const clientTransport = createTcpP2PDataPlaneTransport({
        remoteHost: '127.0.0.1',
        remotePort: winningRemotePort,
        socket: winnerPair.clientSocket,
        timeoutMs: 2_000,
      });
      const fetchViaP2P = createP2PDataPlaneFetch({ route: p2pRoute, transport: clientTransport });

      const response = await fetchViaP2P('https://node-1.pods.example/alice/agent-winner.txt');

      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toBe('node-side deterministic winner');
      expect(updatedSession?.candidates.filter((candidate) => candidate.role === 'node')).toEqual([
        expect.objectContaining({ sourceId: 'node-1', host: '127.0.0.1', port: wrongRemotePort }),
        expect.objectContaining({ sourceId: 'node-1', host: '127.0.0.1', port: winningRemotePort }),
      ]);
      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:3000/alice/agent-winner.txt',
        expect.objectContaining({ method: 'GET' }),
      );
      clientTransport.close();
    } finally {
      await wrongPair.close();
      await winnerPair.close();
    }
  });

});


const p2pRoute: AccessRoute = {
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
      'raw-tcp-hole-punch': { enabled: true },
    },
  },
};

async function reserveTcpPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected TCP address info');
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return address.port;
}

async function createSocketPair(): Promise<{
  clientSocket: Socket;
  serverSocket: Socket;
  close: () => Promise<void>;
}> {
  const server = createServer();
  const serverSocketPromise = new Promise<Socket>((resolve) => {
    server.once('connection', resolve);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  const clientSocket = await new Promise<Socket>((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port: address.port });
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
  const serverSocket = await serverSocketPromise;
  return {
    clientSocket,
    serverSocket,
    async close(): Promise<void> {
      clientSocket.destroy();
      serverSocket.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    },
  };
}

function sleepTest(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
