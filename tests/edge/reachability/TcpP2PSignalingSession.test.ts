import { describe, expect, it, vi } from 'vitest';
import { createConnection, createServer, type AddressInfo, type Socket } from 'node:net';
import type {
  P2PSession,
  P2PSignalingClient,
  P2PTransportCandidate,
  RawTcpP2PConnectAttempt,
} from '../../../src/edge/reachability';
import {
  answerPendingRawTcpP2PSessionsOnce,
  attachTcpP2PDataPlaneSocket,
  connectRawTcpP2PTransport,
  connectSignaledRawTcpP2PTransport,
  createP2PDataPlaneFetch,
  createP2PDataPlaneHandler,
  createSignaledRawTcpP2PSession,
  createRawTcpHolePunchCandidates,
  createTcpP2PDataPlaneServer,
  RAW_TCP_HOLE_PUNCH_TRANSPORT,
  waitForRawTcpRemoteCandidates,
} from '../../../src/edge/reachability';

const baseSession: P2PSession = {
  sessionId: 'p2p_1',
  kind: 'p2p',
  nodeId: 'node-1',
  clientId: 'device-1',
  auditId: 'audit_1',
  createdAt: '2026-06-20T00:00:00.000Z',
  expiresAt: '2026-06-20T00:05:00.000Z',
  nodeCandidates: [
    {
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
    },
  ],
  signalingUrl: 'https://api.example/v1/signal/nodes/node-1/sessions/p2p_1',
  capabilities: ['tcp-punch'],
  candidates: [],
};

describe('signaled raw TCP P2P sessions', () => {
  it('creates a p2p session with deterministic raw TCP hole-punch candidates', async () => {
    let createdCandidates: P2PTransportCandidate[] = [];
    const signaling: P2PSignalingClient = {
      createP2PSession: vi.fn(async (request) => {
        expect(request.clientId).toBe('device-1');
        expect(request.capabilities).toContain('tcp-punch');
        createdCandidates = request.candidates ?? [];
        return {
          ...baseSession,
          candidates: createdCandidates,
        };
      }),
      listP2PSessions: vi.fn(),
      getP2PSession: vi.fn(),
      addP2PCandidates: vi.fn(),
    };

    const result = await createSignaledRawTcpP2PSession({
      signaling,
      clientId: 'device-1',
      host: '198.51.100.10',
      planOptions: {
        nowSeconds: 1_000,
        windowSeconds: 42,
        maxClockErrorSeconds: 20,
        minRunWindowSeconds: 10,
        numPorts: 3,
        basePort: 40_000,
        portRange: 100,
      },
    });

    expect(result.rawTcpRoute?.id).toBe('p2p-raw-tcp');
    expect(result.localCandidates).toHaveLength(3);
    expect(createdCandidates).toHaveLength(3);
    expect(createdCandidates).toEqual(result.localCandidates);
    expect(createdCandidates).toEqual([
      expect.objectContaining({
        role: 'client',
        sourceId: 'device-1',
        protocol: 'tcp',
        transport: RAW_TCP_HOLE_PUNCH_TRANSPORT,
        host: '198.51.100.10',
        metadata: expect.objectContaining({
          provider: RAW_TCP_HOLE_PUNCH_TRANSPORT,
          bucket: result.plan.bucket,
          rendezvousTimeSeconds: result.plan.rendezvousTimeSeconds,
        }),
      }),
      expect.any(Object),
      expect.any(Object),
    ]);
  });

  it('answers pending client-created raw TCP sessions with node candidates for the same bucket', async () => {
    const clientCandidates = createRawTcpHolePunchCandidates({
      role: 'client',
      sourceId: 'device-1',
      host: '198.51.100.10',
      planOptions: {
        nowSeconds: 1_000,
        windowSeconds: 42,
        maxClockErrorSeconds: 20,
        minRunWindowSeconds: 10,
        numPorts: 2,
        basePort: 40_000,
        portRange: 100,
      },
    });
    let update: Parameters<P2PSignalingClient['addP2PCandidates']>[1] | undefined;
    const signaling: P2PSignalingClient = {
      createP2PSession: vi.fn(),
      listP2PSessions: vi.fn(async () => [{ ...baseSession, candidates: clientCandidates }]),
      getP2PSession: vi.fn(),
      addP2PCandidates: vi.fn(async (_sessionIdOrUrl, request) => {
        update = request;
        return {
          ...baseSession,
          candidates: [...clientCandidates, ...(request.candidates as P2PTransportCandidate[])],
        };
      }),
    };

    const answered = await answerPendingRawTcpP2PSessionsOnce({
      signaling,
      sourceId: 'node-1',
      host: '203.0.113.20',
    });

    expect(answered).toHaveLength(1);
    expect(update).toMatchObject({
      role: 'node',
      sourceId: 'node-1',
      candidates: [
        expect.objectContaining({
          role: 'node',
          sourceId: 'node-1',
          host: '203.0.113.20',
          transport: RAW_TCP_HOLE_PUNCH_TRANSPORT,
          metadata: expect.objectContaining({
            bucket: clientCandidates[0].metadata?.bucket,
          }),
        }),
        expect.any(Object),
      ],
    });
  });

  it('waits for remote raw TCP candidates through signaling polling', async () => {
    const planCandidates = createRawTcpHolePunchCandidates({
      role: 'client',
      sourceId: 'device-1',
      host: '198.51.100.10',
      planOptions: {
        nowSeconds: 1_000,
        windowSeconds: 42,
        maxClockErrorSeconds: 20,
        minRunWindowSeconds: 10,
        numPorts: 1,
        basePort: 40_000,
        portRange: 100,
      },
    });
    const nodeCandidates = createRawTcpHolePunchCandidates({
      role: 'node',
      sourceId: 'node-1',
      host: '203.0.113.20',
      plan: {
        bucket: Number(planCandidates[0].metadata?.bucket),
        boundary: Number(planCandidates[0].metadata?.boundary),
        rendezvousTimeSeconds: Number(planCandidates[0].metadata?.rendezvousTimeSeconds),
        ports: [Number(planCandidates[0].port)],
      },
    });
    let calls = 0;
    const signaling: P2PSignalingClient = {
      createP2PSession: vi.fn(),
      listP2PSessions: vi.fn(),
      getP2PSession: vi.fn(async () => {
        calls += 1;
        return calls === 1
          ? { ...baseSession, candidates: planCandidates }
          : { ...baseSession, candidates: [...planCandidates, ...nodeCandidates] };
      }),
      addP2PCandidates: vi.fn(),
    };

    const remoteCandidates = await waitForRawTcpRemoteCandidates({
      signaling,
      sessionIdOrUrl: baseSession.signalingUrl,
      localRole: 'client',
      localSourceId: 'device-1',
      bucket: Number(planCandidates[0].metadata?.bucket),
      pollIntervalMs: 1,
      timeoutMs: 100,
    });

    expect(remoteCandidates).toEqual([
      expect.objectContaining({
        role: 'node',
        sourceId: 'node-1',
        host: '203.0.113.20',
        transport: RAW_TCP_HOLE_PUNCH_TRANSPORT,
      }),
    ]);
    expect(signaling.getP2PSession).toHaveBeenCalledTimes(2);
  });

  it('connects raw TCP candidates into a P2P HTTP data-plane transport', async () => {
    const localFetch = vi.fn(async () => new Response('candidate transport response', {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    }));
    const handler = createP2PDataPlaneHandler({
      targetBaseUrl: 'http://127.0.0.1:5737/',
      fetchImpl: localFetch as typeof fetch,
    });
    const server = createTcpP2PDataPlaneServer({ handler, host: '127.0.0.1' });
    await server.listen(0);

    try {
      const remotePort = server.address().port;
      const localPort = await reserveTcpPort();
      const plan = {
        bucket: 99,
        boundary: 123,
        rendezvousTimeSeconds: 1_000,
        ports: [localPort],
      };
      const localCandidates = createRawTcpHolePunchCandidates({
        role: 'client',
        sourceId: 'device-1',
        host: '127.0.0.1',
        plan,
      });
      const remoteCandidates = createRawTcpHolePunchCandidates({
        role: 'node',
        sourceId: 'node-1',
        host: '127.0.0.1',
        plan: {
          ...plan,
          ports: [remotePort],
        },
      });

      const transport = await connectRawTcpP2PTransport({
        localCandidates,
        remoteCandidates,
        timeoutMs: 2_000,
        connectTimeoutMs: 1_000,
      });
      const fetchViaP2P = createP2PDataPlaneFetch({ route: baseSession.nodeCandidates[0], transport });

      const response = await fetchViaP2P('https://node-1.pods.example/alice/raw-tcp.txt');

      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toBe('candidate transport response');
      expect(localFetch).toHaveBeenCalledWith(
        'http://127.0.0.1:5737/alice/raw-tcp.txt',
        expect.objectContaining({ method: 'GET' }),
      );
      transport.close();
    } finally {
      await server.close();
    }
  });

  it('creates a signaled raw TCP session, waits for node candidates, and connects the data plane', async () => {
    const localFetch = vi.fn(async () => new Response('client flow response', {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    }));
    const handler = createP2PDataPlaneHandler({
      targetBaseUrl: 'http://127.0.0.1:5737/',
      fetchImpl: localFetch as typeof fetch,
    });
    const { clientSocket, serverSocket, close } = await createSocketPair();
    const socketHandle = attachTcpP2PDataPlaneSocket({ socket: serverSocket, handler });
    const remotePort = await reserveTcpPort();
    const localPort = await reserveTcpPort();
    const plan = {
      bucket: 103,
      boundary: 111,
      rendezvousTimeSeconds: 0,
      ports: [localPort],
    };
    const nodeCandidates = createRawTcpHolePunchCandidates({
      role: 'node',
      sourceId: 'node-1',
      host: '127.0.0.1',
      plan: {
        ...plan,
        ports: [remotePort],
      },
    });
    const createdSessions: P2PTransportCandidate[][] = [];
    const signaling: P2PSignalingClient = {
      createP2PSession: vi.fn(async (request) => {
        createdSessions.push(request.candidates ?? []);
        return {
          ...baseSession,
          candidates: request.candidates ?? [],
        };
      }),
      listP2PSessions: vi.fn(),
      getP2PSession: vi.fn(async () => ({
        ...baseSession,
        candidates: [...createdSessions[0], ...nodeCandidates],
      })),
      addP2PCandidates: vi.fn(),
    };
    const attempts: RawTcpP2PConnectAttempt[] = [];

    try {
      const result = await connectSignaledRawTcpP2PTransport({
        signaling,
        clientId: 'device-1',
        host: '127.0.0.1',
        plan,
        timeoutMs: 2_000,
        connectTimeoutMs: 1_000,
        pollIntervalMs: 1,
        waitTimeoutMs: 100,
        connectSocket: async (attempt) => {
          attempts.push(attempt);
          return clientSocket;
        },
      });
      const fetchViaP2P = createP2PDataPlaneFetch({ route: baseSession.nodeCandidates[0], transport: result.transport });

      const response = await fetchViaP2P('https://node-1.pods.example/alice/client-flow.txt');

      expect(result.session.sessionId).toBe(baseSession.sessionId);
      expect(result.plan).toEqual(plan);
      expect(result.localCandidates).toEqual(createdSessions[0]);
      expect(result.remoteCandidates).toEqual(nodeCandidates);
      expect(signaling.createP2PSession).toHaveBeenCalledTimes(1);
      expect(signaling.getP2PSession).toHaveBeenCalledWith(baseSession.signalingUrl);
      expect(attempts).toEqual([
        expect.objectContaining({
          local: expect.objectContaining({ sourceId: 'device-1', port: localPort }),
          remote: expect.objectContaining({ sourceId: 'node-1', port: remotePort }),
        }),
      ]);
      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toBe('client flow response');
      result.transport.close();
    } finally {
      socketHandle.close();
      await close();
    }
  });

  it('waits for rendezvous and attaches a native simultaneous-open socket through an injected connector', async () => {
    const localFetch = vi.fn(async () => new Response('simultaneous-open response', {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    }));
    const handler = createP2PDataPlaneHandler({
      targetBaseUrl: 'http://127.0.0.1:5737/',
      fetchImpl: localFetch as typeof fetch,
    });
    const { clientSocket, serverSocket, close } = await createSocketPair();
    const socketHandle = attachTcpP2PDataPlaneSocket({ socket: serverSocket, handler });
    const unusedRemotePort = await reserveTcpPort();
    const localPort = await reserveTcpPort();
    const plan = {
      bucket: 100,
      boundary: 321,
      rendezvousTimeSeconds: 20,
      ports: [localPort],
    };
    const localCandidates = createRawTcpHolePunchCandidates({
      role: 'client',
      sourceId: 'device-1',
      host: '127.0.0.1',
      plan,
    });
    const remoteCandidates = createRawTcpHolePunchCandidates({
      role: 'node',
      sourceId: 'node-1',
      host: '127.0.0.1',
      plan: {
        ...plan,
        ports: [unusedRemotePort],
      },
    });
    const sleeps: number[] = [];
    const attempts: unknown[] = [];

    try {
      const transport = await connectRawTcpP2PTransport({
        localCandidates,
        remoteCandidates,
        timeoutMs: 2_000,
        connectTimeoutMs: 1_000,
        nowMs: () => 19_500,
        sleepMs: async (ms: number) => {
          sleeps.push(ms);
        },
        connectSocket: async (attempt: unknown) => {
          attempts.push(attempt);
          return clientSocket;
        },
      });
      const fetchViaP2P = createP2PDataPlaneFetch({ route: baseSession.nodeCandidates[0], transport });

      const response = await fetchViaP2P('https://node-1.pods.example/alice/simultaneous-open.txt');

      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toBe('simultaneous-open response');
      expect(sleeps).toEqual([500]);
      expect(attempts).toEqual([
        expect.objectContaining({
          local: expect.objectContaining({ sourceId: 'device-1', port: localPort }),
          remote: expect.objectContaining({ sourceId: 'node-1', port: unusedRemotePort }),
          remoteHost: '127.0.0.1',
          remotePort: unusedRemotePort,
          localPort,
          rendezvousTimeMs: 20_000,
          timeoutMs: 1_000,
        }),
      ]);
      transport.close();
    } finally {
      socketHandle.close();
      await close();
    }
  });

  it('races compatible raw TCP candidate pairs instead of blocking on the first port', async () => {
    const localFetch = vi.fn(async () => new Response('raced socket response', {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    }));
    const handler = createP2PDataPlaneHandler({
      targetBaseUrl: 'http://127.0.0.1:5737/',
      fetchImpl: localFetch as typeof fetch,
    });
    const { clientSocket, serverSocket, close } = await createSocketPair();
    const socketHandle = attachTcpP2PDataPlaneSocket({ socket: serverSocket, handler });
    const blockedRemotePort = await reserveTcpPort();
    const workingRemotePort = await reserveTcpPort();
    const localPort = await reserveTcpPort();
    const basePlan = {
      bucket: 101,
      boundary: 654,
      rendezvousTimeSeconds: 0,
      ports: [localPort],
    };
    const localCandidates = createRawTcpHolePunchCandidates({
      role: 'client',
      sourceId: 'device-1',
      host: '127.0.0.1',
      plan: basePlan,
    });
    const remoteCandidates = createRawTcpHolePunchCandidates({
      role: 'node',
      sourceId: 'node-1',
      host: '127.0.0.1',
      plan: {
        ...basePlan,
        ports: [blockedRemotePort, workingRemotePort],
      },
    });
    const attempts: RawTcpP2PConnectAttempt[] = [];

    try {
      const transport = await withTimeout(connectRawTcpP2PTransport({
        localCandidates,
        remoteCandidates,
        timeoutMs: 2_000,
        connectTimeoutMs: 1_000,
        connectSocket: async (attempt) => {
          attempts.push(attempt);
          if (attempt.remotePort === blockedRemotePort) {
            return new Promise<Socket>(() => undefined);
          }
          return clientSocket;
        },
      }), 100);
      const fetchViaP2P = createP2PDataPlaneFetch({ route: baseSession.nodeCandidates[0], transport });

      const response = await fetchViaP2P('https://node-1.pods.example/alice/raced.txt');

      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toBe('raced socket response');
      expect(attempts.map((attempt) => attempt.remotePort)).toEqual([blockedRemotePort, workingRemotePort]);
      transport.close();
    } finally {
      socketHandle.close();
      await close();
    }
  });

  it('aborts pending rendezvous timers after another raw TCP candidate wins', async () => {
    const localFetch = vi.fn(async () => new Response('timer cleanup response', {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    }));
    const handler = createP2PDataPlaneHandler({
      targetBaseUrl: 'http://127.0.0.1:5737/',
      fetchImpl: localFetch as typeof fetch,
    });
    const { clientSocket, serverSocket, close } = await createSocketPair();
    const socketHandle = attachTcpP2PDataPlaneSocket({ socket: serverSocket, handler });
    const futureRemotePort = await reserveTcpPort();
    const immediateRemotePort = await reserveTcpPort();
    const localPort = await reserveTcpPort();
    const nowMs = 10_000;
    const localCandidates = createRawTcpHolePunchCandidates({
      role: 'client',
      sourceId: 'device-1',
      host: '127.0.0.1',
      plan: {
        bucket: 102,
        boundary: 987,
        rendezvousTimeSeconds: 10,
        ports: [localPort],
      },
    });
    const remoteCandidates = [
      ...createRawTcpHolePunchCandidates({
        role: 'node',
        sourceId: 'node-1',
        host: '127.0.0.1',
        priority: 100,
        plan: {
          bucket: 102,
          boundary: 987,
          rendezvousTimeSeconds: 20,
          ports: [futureRemotePort],
        },
      }),
      ...createRawTcpHolePunchCandidates({
        role: 'node',
        sourceId: 'node-1',
        host: '127.0.0.1',
        priority: 90,
        plan: {
          bucket: 102,
          boundary: 987,
          rendezvousTimeSeconds: 10,
          ports: [immediateRemotePort],
        },
      }),
    ];
    const scheduledTimers = new Set<NodeJS.Timeout>();

    vi.useFakeTimers();
    try {
      const transport = await connectRawTcpP2PTransport({
        localCandidates,
        remoteCandidates,
        timeoutMs: 2_000,
        connectTimeoutMs: 1_000,
        nowMs: () => nowMs,
        sleepMs: async (ms, signal) => new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            scheduledTimers.delete(timer);
            resolve();
          }, ms);
          const onAbort = (): void => {
            clearTimeout(timer);
            scheduledTimers.delete(timer);
            reject(new Error('sleep aborted'));
          };
          scheduledTimers.add(timer);
          signal?.addEventListener('abort', onAbort, { once: true });
        }),
        connectSocket: async (attempt) => {
          if (attempt.remotePort === futureRemotePort) {
            throw new Error('future candidate should wait');
          }
          return clientSocket;
        },
      });
      const fetchViaP2P = createP2PDataPlaneFetch({ route: baseSession.nodeCandidates[0], transport });

      const response = await fetchViaP2P('https://node-1.pods.example/alice/timer-cleanup.txt');

      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toBe('timer cleanup response');
      expect(scheduledTimers.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      transport.close();
    } finally {
      vi.useRealTimers();
      socketHandle.close();
      await close();
    }
  });
});

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

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
