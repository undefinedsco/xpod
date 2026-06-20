import { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServerResponse } from 'node:http';
import { ApiServer } from '../../../src/api/ApiServer';
import type { AuthenticatedRequest } from '../../../src/api/middleware/AuthMiddleware';
import { registerEdgeNodeSignalRoutes } from '../../../src/api/handlers/EdgeNodeSignalHandler';
import { registerReachabilityRoutes } from '../../../src/api/handlers/ReachabilityHandler';
import { EdgeNodeAgent } from '../../../src/edge/EdgeNodeAgent';
import { createWeriftSignaledP2PDataPlaneClientFromApi } from '../../../src/edge/reachability';

class InMemoryEdgeNodeRepository {
  public metadata: Record<string, unknown> = {};
  public readonly heartbeats: Array<Record<string, unknown>> = [];

  public async getNodeMetadata(nodeId: string): Promise<{ nodeId: string; metadata: Record<string, unknown> }> {
    return { nodeId, metadata: this.metadata };
  }

  public async getNodeConnectivityInfo(nodeId: string): Promise<Record<string, unknown>> {
    return {
      nodeId,
      publicUrl: 'https://node-1.pods.example/',
      connectivityStatus: 'reachable',
    };
  }

  public async updateNodeHeartbeat(_nodeId: string, metadata: Record<string, unknown>): Promise<void> {
    this.metadata = { ...metadata };
    this.heartbeats.push(this.metadata);
  }

  public async replaceNodePods(): Promise<void> {}

  public async mergeNodeMetadata(_nodeId: string, patch: Record<string, unknown>): Promise<void> {
    this.metadata = deepMerge(this.metadata, patch);
  }
}

describe('werift P2P data plane over real HTTP signaling API', () => {
  let server: ApiServer | undefined;
  let agent: EdgeNodeAgent | undefined;

  afterEach(async () => {
    agent?.stop();
    agent = undefined;
    if (server) {
      await server.stop();
      server = undefined;
    }
  });

  it('uses node heartbeat route discovery, HTTP signaling, node answer loop, and canonical Solid fetch', async () => {
    const repository = new InMemoryEdgeNodeRepository();
    server = new ApiServer({
      host: '127.0.0.1',
      port: 0,
      authMiddleware: {
        process: async (request: AuthenticatedRequest, response: ServerResponse): Promise<boolean> => {
          const authorization = request.headers.authorization;
          if (authorization === 'Bearer node-token') {
            request.auth = { type: 'node', nodeId: 'node-1' };
            return true;
          }
          if (authorization === 'Bearer managed-client-token') {
            request.auth = {
              type: 'service',
              serviceType: 'local',
              serviceId: 'managed-client',
              scopes: ['p2p:connect'],
            };
            return true;
          }
          response.statusCode = 401;
          response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify({ error: 'Unauthorized' }));
          return false;
        },
      } as any,
    });
    registerEdgeNodeSignalRoutes(server, { repository: repository as any });
    registerReachabilityRoutes(server, {
      repository: repository as any,
      apiBaseUrl: 'http://127.0.0.1/',
      baseStorageDomain: 'pods.example',
    });
    await server.start();
    const address = server.getHttpServer()!.address() as AddressInfo;
    const apiBaseUrl = `http://127.0.0.1:${address.port}/`;

    const localFetch = vi.fn(async () => new Response('live-http-signaling response', {
      status: 213,
      headers: { 'content-type': 'text/plain' },
    }));
    const peerConfig = {
      iceServers: [],
      iceAdditionalHostAddresses: ['127.0.0.1'],
    };

    agent = new EdgeNodeAgent();
    await agent.start({
      signalEndpoint: new URL('/v1/signal/heartbeat', apiBaseUrl).toString(),
      nodeId: 'node-1',
      nodeToken: 'node-token',
      baseUrl: 'https://node-1.pods.example/',
      enableNetworkDetection: false,
      intervalMs: 60_000,
      p2p: {
        enabled: true,
        apiBaseUrl,
        targetBaseUrl: 'http://127.0.0.1:5737/',
        fetchImpl: localFetch as typeof fetch,
        pollIntervalMs: 50,
        signalingPollIntervalMs: 10,
        timeoutMs: 4_000,
        peerConfig,
      },
    });

    await vi.waitFor(() => {
      const routes = repository.metadata.routes as Array<Record<string, unknown>> | undefined;
      expect(routes?.some((route) => route.kind === 'p2p' && route.targetUrl === 'webrtc://signaling/node-1')).toBe(true);
    });

    const client = await createWeriftSignaledP2PDataPlaneClientFromApi({
      apiBaseUrl,
      nodeId: 'node-1',
      token: 'managed-client-token',
      sourceId: 'native-device-1',
      capabilities: ['webrtc-datachannel'],
      timeoutMs: 4_000,
      pollIntervalMs: 10,
      transportTimeoutMs: 2_000,
      peerConfig,
    });

    try {
      const response = await client.fetch('https://node-1.pods.example/alice/live-http-signaling.txt', {
        method: 'PUT',
        headers: { authorization: 'DPoP token', 'content-type': 'text/plain' },
        body: 'hello over real HTTP signaling',
      });

      expect(client.session.nodeCandidates.map((route) => route.kind)).toContain('p2p');
      expect(response.status).toBe(213);
      await expect(response.text()).resolves.toBe('live-http-signaling response');
      expect(localFetch).toHaveBeenCalledTimes(1);
      const [targetUrl, init] = localFetch.mock.calls[0];
      expect(targetUrl).toBe('http://127.0.0.1:5737/alice/live-http-signaling.txt');
      const headers = new Headers(init.headers);
      expect(headers.get('authorization')).toBe('DPoP token');
      expect(headers.get('x-xpod-canonical-url')).toBe('https://node-1.pods.example/alice/live-http-signaling.txt');
    } finally {
      await client.close();
    }
  });
});

function deepMerge(left: Record<string, unknown>, right: Record<string, unknown>): Record<string, unknown> {
  const merged = { ...left };
  for (const [key, value] of Object.entries(right)) {
    if (isRecord(value) && isRecord(merged[key])) {
      merged[key] = deepMerge(merged[key] as Record<string, unknown>, value);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
