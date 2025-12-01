import { PassThrough } from 'node:stream';
import { describe, it, expect, vi } from 'vitest';
import type { HttpResponse } from '@solid/community-server/dist/server/HttpResponse';
import { EdgeNodeSignalHttpHandler } from '../../src/http/admin/EdgeNodeSignalHttpHandler';
import { EdgeNodeProxyHttpHandler } from '../../src/http/EdgeNodeProxyHttpHandler';

const ResponseCtor = Response;

describe('EdgeClusterFlow integration', () => {
  it('switches between redirect/proxy modes and proxies traffic accordingly', async () => {
    let storedMetadata: Record<string, unknown> = {};
    let connectivity: any = undefined;

    const repo = {
      getNodeSecret: vi.fn().mockResolvedValue({ nodeId: 'node-1', tokenHash: 'hash', metadata: storedMetadata }),
      matchesToken: vi.fn().mockReturnValue(true),
      updateNodeHeartbeat: vi.fn().mockImplementation(async (_id: string, metadata: Record<string, unknown>) => {
        storedMetadata = metadata;
      }),
      replaceNodePods: vi.fn(),
      updateNodeMode: vi.fn().mockImplementation(async (_id: string, payload: any) => {
        connectivity = { nodeId: 'node-1', ...payload };
      }),
      getNodeConnectivityInfo: vi.fn().mockImplementation(async () => connectivity),
      findNodeBySubdomain: vi.fn().mockImplementation(async (host: string) => ({
        nodeId: 'node-1',
        accessMode: connectivity?.accessMode,
        metadata: storedMetadata,
        subdomain: host,
      })),
    };

    const dnsCoordinator = { synchronize: vi.fn() };
    const signalHandler = new EdgeNodeSignalHttpHandler({
      identityDbUrl: 'postgres://test',
      edgeNodesEnabled: 'true',
      repository: repo as any,
      dnsCoordinator: dnsCoordinator as any,
    });

    function createHttpResponse(): HttpResponse & PassThrough {
      const stream = new PassThrough() as HttpResponse & PassThrough;
      (stream as any).headers = {};
      stream.setHeader = (name: string, value: any): void => {
        (stream as any).headers[name.toLowerCase()] = value;
      };
      stream.writeHead = () => stream;
      stream.end = ((chunk?: any): any => {
        if (chunk) {
          stream.write(chunk);
        }
        stream.emit('finish');
        return stream;
      }) as any;
      return stream;
    }

    async function sendHeartbeat(body: Record<string, unknown>): Promise<void> {
      const request = new PassThrough() as any;
      request.method = 'POST';
      request.url = '/api/signal';
      request.headers = { host: 'cluster.example' };
      request.end(JSON.stringify(body));
      const response = createHttpResponse();
      await signalHandler.handle({ request, response });
    }

    await sendHeartbeat({
      nodeId: 'node-1',
      token: 'secret',
      ipv4: '203.0.113.10',
      publicAddress: 'https://node.direct/',
      reachability: { status: 'redirect' },
    });
    expect(connectivity.accessMode).toBe('direct');
    expect(dnsCoordinator.synchronize).toHaveBeenCalledWith('node-1', expect.objectContaining({ accessMode: 'direct' }));

    await sendHeartbeat({
      nodeId: 'node-1',
      token: 'secret',
      reachability: { status: 'unreachable' },
      tunnel: {
        status: 'active',
        entrypoint: 'https://proxy.cluster/internal/node-1',
      },
    });
    expect(connectivity.accessMode).toBe('proxy');

    const fetchMock = vi.fn().mockResolvedValue(new ResponseCtor('ok', { status: 200 }));
    const proxyHandler = new EdgeNodeProxyHttpHandler({
      identityDbUrl: 'postgres://test',
      edgeNodesEnabled: 'true',
      repository: repo as any,
      fetchImpl: fetchMock as any,
    });
    const proxyRequest = new PassThrough() as any;
    proxyRequest.method = 'GET';
    proxyRequest.url = '/foo';
    proxyRequest.headers = { host: 'node-1.cluster.example' };
    proxyRequest.end();
    const proxyResponse = createHttpResponse();
    const finished = new Promise((resolve) => proxyResponse.on('finish', resolve));
    await proxyHandler.handle({ request: proxyRequest, response: proxyResponse });
    await finished;
    expect(fetchMock).toHaveBeenCalledWith(
      'https://proxy.cluster/foo',
      expect.objectContaining({ method: 'GET' })
    );
  });
});
