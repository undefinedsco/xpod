import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { HttpRequest } from '@solid/community-server/dist/server/HttpRequest';
import type { HttpResponse } from '@solid/community-server/dist/server/HttpResponse';
import { NotImplementedHttpError } from '@solid/community-server/dist/util/errors/NotImplementedHttpError';
import { MethodNotAllowedHttpError } from '@solid/community-server/dist/util/errors/MethodNotAllowedHttpError';
import { UnauthorizedHttpError } from '@solid/community-server/dist/util/errors/UnauthorizedHttpError';
import { BadRequestHttpError } from '@solid/community-server/dist/util/errors/BadRequestHttpError';
import { EdgeNodeSignalHttpHandler } from '../../src/http/admin/EdgeNodeSignalHttpHandler';

const getNodeSecretMock = vi.fn();
const updateNodeHeartbeatMock = vi.fn();
const matchesTokenMock = vi.fn();
const replaceNodePodsMock = vi.fn();
const getNodeConnectivityInfoMock = vi.fn();
const updateNodeModeMock = vi.fn();
const modeDetectorMock = {
  detectMode: vi.fn(),
  recheckMode: vi.fn(),
};

class MockResponse extends EventEmitter {
  public statusCode = 200;
  public readonly headers: Record<string, any> = {};
  private readonly chunks: Buffer[] = [];
  public finished = false;
  public readonly done: Promise<void>;
  private resolveDone!: () => void;

  public constructor() {
    super();
    this.done = new Promise<void>((resolve) => {
      this.resolveDone = resolve;
    });
  }

  public setHeader(name: string, value: any): void {
    this.headers[name.toLowerCase()] = value;
  }

  public getHeader(name: string): any {
    return this.headers[name.toLowerCase()];
  }

  public write(chunk: any): boolean {
    if (chunk) {
      this.chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk));
    }
    return true;
  }

  public end(chunk?: any): void {
    if (chunk) {
      this.write(chunk);
    }
    this.finished = true;
    this.resolveDone();
  }

  public getBody(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

function createRequest(method: string, path: string, body?: string): HttpRequest {
  const stream = new PassThrough();
  const request = stream as unknown as HttpRequest;
  // @ts-expect-error test double assignment
  request.method = method;
  // @ts-expect-error test double assignment
  request.url = path;
  // @ts-expect-error test double assignment
  request.headers = { host: 'cluster.example' };
  const setEncoding = stream.setEncoding.bind(stream);
  request.setEncoding = ((encoding: string) => {
    setEncoding(encoding);
    return request;
  }) as HttpRequest['setEncoding'];
  if (body) {
    stream.end(body);
  } else {
    stream.end();
  }
  return request;
}

function buildHandler(enabled = true, withModeDetector = false): EdgeNodeSignalHttpHandler {
  return new EdgeNodeSignalHttpHandler({
    identityDbUrl: 'postgres://test',
    edgeNodesEnabled: enabled ? 'true' : 'false',
    basePath: '/api/signal',
    repository: {
      getNodeSecret: getNodeSecretMock,
      updateNodeHeartbeat: updateNodeHeartbeatMock,
      matchesToken: matchesTokenMock,
      replaceNodePods: replaceNodePodsMock,
      getNodeConnectivityInfo: getNodeConnectivityInfoMock,
      updateNodeMode: updateNodeModeMock,
    } as any,
    modeDetector: withModeDetector ? modeDetectorMock as any : undefined,
    clusterBaseDomain: withModeDetector ? 'cluster.example.com' : undefined,
  });
}

// TODO: Skip signal tests for now
describe.skip('EdgeNodeSignalHttpHandler', () => {
  beforeEach(() => {
    getNodeSecretMock.mockReset();
    updateNodeHeartbeatMock.mockReset();
    matchesTokenMock.mockReset();
    replaceNodePodsMock.mockReset();
    getNodeConnectivityInfoMock.mockReset();
    updateNodeModeMock.mockReset();
    modeDetectorMock.detectMode.mockReset();
    modeDetectorMock.recheckMode.mockReset();
    matchesTokenMock.mockReturnValue(true);
  });

  it('禁用状态下拒绝处理', async () => {
    const handler = buildHandler(false);
    const request = createRequest('POST', '/api/signal');
    await expect(handler.canHandle({ request } as any)).rejects.toBeInstanceOf(NotImplementedHttpError);
  });

  it('非信令路径交由后续处理', async () => {
    const handler = buildHandler();
    const request = createRequest('POST', '/healthz');
    await expect(handler.canHandle({ request } as any)).rejects.toBeInstanceOf(NotImplementedHttpError);
  });

  it('OPTIONS 返回允许方法', async () => {
    const handler = buildHandler();
    const request = createRequest('OPTIONS', '/api/signal');
    const response = new MockResponse() as unknown as HttpResponse;

    await handler.handle({ request, response });
    await (response as unknown as MockResponse).done;

    expect(response.statusCode).toBe(204);
    expect(response.getHeader('allow')).toBe('POST,OPTIONS');
  });

  it('仅允许 POST 方法', async () => {
    const handler = buildHandler();
    const request = createRequest('GET', '/api/signal');
    const response = new MockResponse() as unknown as HttpResponse;

    await handler.handle({ request, response });
    await (response as unknown as MockResponse).done;

    expect(response.statusCode).toBe(405);
  });

  it('缺少必要字段返回 400', async () => {
    const handler = buildHandler();
    const request = createRequest('POST', '/api/signal', JSON.stringify({ nodeId: 'node-1' }));
    const response = new MockResponse() as unknown as HttpResponse;

    await handler.handle({ request, response });
    await (response as unknown as MockResponse).done;

    expect(response.statusCode).toBe(400);
  });

  it('身份验证失败返回 401', async () => {
    const handler = buildHandler();
    getNodeSecretMock.mockResolvedValueOnce({ nodeId: 'node-1', tokenHash: 'abc', metadata: {} });
    matchesTokenMock.mockReturnValueOnce(false);

    const request = createRequest('POST', '/api/signal', JSON.stringify({ nodeId: 'node-1', token: 'wrong' }));
    const response = new MockResponse() as unknown as HttpResponse;

    await handler.handle({ request, response });
    await (response as unknown as MockResponse).done;

    expect(response.statusCode).toBe(401);
  });

  it('成功记录心跳并合并元数据', async () => {
    const handler = buildHandler();
    const existingMeta = { baseUrl: 'https://old.example/', version: '1.0.0' };
    getNodeSecretMock.mockResolvedValueOnce({ nodeId: 'node-1', tokenHash: 'hash', metadata: existingMeta });
    updateNodeHeartbeatMock.mockResolvedValueOnce(undefined);

    const request = createRequest('POST', '/api/signal', JSON.stringify({
      nodeId: 'node-1',
      token: 'secret',
      baseUrl: 'https://node.example/',
      publicAddress: 'https://public.example/',
      hostname: 'edge-a',
      ipv4: '10.0.0.2',
      ipv6: '::1',
      version: '1.2.0',
      status: 'online',
      capabilities: [ 'sparql', 'storage' ],
      pods: [ 'https://node.example/', 'https://node.example/pod-b/' ],
    }));
    const response = new MockResponse() as unknown as HttpResponse;

    await handler.handle({ request, response });
    await (response as unknown as MockResponse).done;

    expect(updateNodeHeartbeatMock).toHaveBeenCalledTimes(1);
    const metadataArg = updateNodeHeartbeatMock.mock.calls[0][1] as Record<string, unknown>;
    expect(metadataArg.baseUrl).toBe('https://node.example/');
    expect(metadataArg.publicAddress).toBe('https://public.example/');
    expect(metadataArg.hostname).toBe('edge-a');
    expect(metadataArg.capabilities).toEqual([ 'sparql', 'storage' ]);

    const payload = JSON.parse((response as unknown as MockResponse).getBody());
    expect(payload.status).toBe('ok');
    expect(payload.nodeId).toBe('node-1');
    expect(payload.metadata.baseUrl).toBe('https://node.example/');
    expect(replaceNodePodsMock).toHaveBeenCalledWith('node-1', [ 'https://node.example/', 'https://node.example/pod-b/' ]);
  });

  it('未知节点返回 401', async () => {
    const handler = buildHandler();
    getNodeSecretMock.mockResolvedValueOnce(undefined);

    const request = createRequest('POST', '/api/signal', JSON.stringify({ nodeId: 'node-unknown', token: 'secret' }));
    const response = new MockResponse() as unknown as HttpResponse;

    await handler.handle({ request, response });
    await (response as unknown as MockResponse).done;

    expect(response.statusCode).toBe(401);
  });

  it('输入包含无效 URL 时忽略字段', async () => {
    const handler = buildHandler();
    getNodeSecretMock.mockResolvedValueOnce({ nodeId: 'node-1', tokenHash: 'hash', metadata: {} });
    updateNodeHeartbeatMock.mockResolvedValueOnce(undefined);

    const request = createRequest('POST', '/api/signal', JSON.stringify({
      nodeId: 'node-1',
      token: 'secret',
      baseUrl: 'invalid-url',
      capabilities: [ '  ', 1, 'sparql' ],
    }));
    const response = new MockResponse() as unknown as HttpResponse;

    await handler.handle({ request, response });
    await (response as unknown as MockResponse).done;

    const metadataArg = updateNodeHeartbeatMock.mock.calls[0][1] as Record<string, unknown>;
    expect(metadataArg.baseUrl).toBeUndefined();
    expect(metadataArg.capabilities).toEqual([ 'sparql' ]);
    expect(replaceNodePodsMock).not.toHaveBeenCalled();
  });

  it('performs mode detection for new node with public IP', async () => {
    const handler = buildHandler(true, true);
    getNodeSecretMock.mockResolvedValueOnce({ nodeId: 'node-1', tokenHash: 'hash', metadata: {} });
    updateNodeHeartbeatMock.mockResolvedValueOnce(undefined);
    getNodeConnectivityInfoMock.mockResolvedValueOnce(undefined); // No existing connectivity info
    updateNodeModeMock.mockResolvedValueOnce(undefined);
    
    modeDetectorMock.detectMode.mockResolvedValueOnce({
      accessMode: 'direct',
      reason: 'Direct connectivity test passed',
      subdomain: 'node-1.cluster.example.com',
      connectivityTest: { success: true, latency: 50 },
    });

    const request = createRequest('POST', '/api/signal', JSON.stringify({
      nodeId: 'node-1',
      token: 'secret',
      ipv4: '192.168.1.100',
      publicAddress: 'https://node.example.com:3000',
      version: '1.0.0',
    }));
    const response = new MockResponse() as unknown as HttpResponse;

    await handler.handle({ request, response });
    await (response as unknown as MockResponse).done;

    expect(modeDetectorMock.detectMode).toHaveBeenCalledWith({
      nodeId: 'node-1',
      publicIp: '192.168.1.100',
      publicPort: 3000,
      capabilities: {
        solidProtocolVersion: '1.0.0',
        storageBackends: ['filesystem'],
        authMethods: ['webid', 'client-credentials'],
        supportedModes: ['direct', 'proxy'],
        maxBandwidth: undefined,
        location: undefined,
      },
    });

    const lastCall = updateNodeModeMock.mock.calls.at(-1);
    expect(lastCall[0]).toBe('node-1');
    expect(lastCall[1]).toMatchObject({
      accessMode: 'direct',
      publicIp: '192.168.1.100',
      publicPort: 3000,
      subdomain: 'node-1.cluster.example.com',
      connectivityStatus: 'reachable',
      capabilities: {
        solidProtocolVersion: '1.0.0',
        storageBackends: ['filesystem'],
        authMethods: ['webid', 'client-credentials'],
        maxBandwidth: undefined,
        location: undefined,
      },
    });

    const metadataArg = updateNodeHeartbeatMock.mock.calls[0][1] as Record<string, unknown>;
    expect(metadataArg.accessMode).toBe('direct');
    expect(metadataArg.publicIp).toBe('192.168.1.100');
    expect(metadataArg.publicPort).toBe(3000);
    expect(metadataArg.subdomain).toBe('node-1.cluster.example.com');

    expect(response.statusCode).toBe(200);
  });

  it('performs mode recheck for existing proxy node', async () => {
    const handler = buildHandler(true, true);
    getNodeSecretMock.mockResolvedValueOnce({ nodeId: 'node-2', tokenHash: 'hash', metadata: {} });
    updateNodeHeartbeatMock.mockResolvedValueOnce(undefined);
    getNodeConnectivityInfoMock.mockResolvedValueOnce({
      nodeId: 'node-2',
      accessMode: 'proxy',
      publicIp: '10.0.0.1',
      connectivityStatus: 'unreachable',
    });
    updateNodeModeMock.mockResolvedValueOnce(undefined);
    
    modeDetectorMock.recheckMode.mockResolvedValueOnce({
      accessMode: 'direct',
      reason: 'Direct connectivity restored',
      subdomain: 'node-2.cluster.example.com',
      connectivityTest: { success: true, latency: 75 },
    });

    const request = createRequest('POST', '/api/signal', JSON.stringify({
      nodeId: 'node-2',
      token: 'secret',
      ipv4: '10.0.0.1',
      publicAddress: 'https://node2.example.com:443',
    }));
    const response = new MockResponse() as unknown as HttpResponse;

    await handler.handle({ request, response });
    await (response as unknown as MockResponse).done;

    expect(modeDetectorMock.recheckMode).toHaveBeenCalledWith('proxy', {
      nodeId: 'node-2',
      publicIp: '10.0.0.1',
      publicPort: 443,
      capabilities: {
        solidProtocolVersion: '1.0.0',
        storageBackends: ['filesystem'],
        authMethods: ['webid', 'client-credentials'],
        supportedModes: ['direct', 'proxy'],
        maxBandwidth: undefined,
        location: undefined,
      },
    });

    const lastCall = updateNodeModeMock.mock.calls.at(-1);
    expect(lastCall[0]).toBe('node-2');
    expect(lastCall[1]).toMatchObject({
      accessMode: 'direct',
      publicIp: '10.0.0.1',
      publicPort: 443,
      subdomain: 'node-2.cluster.example.com',
      connectivityStatus: 'reachable',
      capabilities: {
        solidProtocolVersion: '1.0.0',
        storageBackends: ['filesystem'],
        authMethods: ['webid', 'client-credentials'],
        maxBandwidth: undefined,
        location: undefined,
      },
    });

    const metadataArg = updateNodeHeartbeatMock.mock.calls[0][1] as Record<string, unknown>;
    expect(metadataArg.accessMode).toBe('direct');
    expect(metadataArg.publicIp).toBe('10.0.0.1');
    expect(metadataArg.publicPort).toBe(443);
    expect(metadataArg.subdomain).toBe('node-2.cluster.example.com');

    expect(response.statusCode).toBe(200);
  });

  it('skips mode detection when no public IP provided', async () => {
    const handler = buildHandler(true, true);
    getNodeSecretMock.mockResolvedValueOnce({ nodeId: 'node-3', tokenHash: 'hash', metadata: {} });
    updateNodeHeartbeatMock.mockResolvedValueOnce(undefined);

    const request = createRequest('POST', '/api/signal', JSON.stringify({
      nodeId: 'node-3',
      token: 'secret',
      hostname: 'node-local',
    }));
    const response = new MockResponse() as unknown as HttpResponse;

    await handler.handle({ request, response });
    await (response as unknown as MockResponse).done;

    expect(modeDetectorMock.detectMode).not.toHaveBeenCalled();
    expect(modeDetectorMock.recheckMode).not.toHaveBeenCalled();
    expect(updateNodeModeMock).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(200);
  });

  it('uses reachability status to keep direct mode without detector', async () => {
    const handler = buildHandler(true, false);
    getNodeSecretMock.mockResolvedValueOnce({ nodeId: 'node-5', tokenHash: 'hash', metadata: {} });
    getNodeConnectivityInfoMock.mockResolvedValueOnce({
      nodeId: 'node-5',
      accessMode: 'proxy',
    });

    const request = createRequest('POST', '/api/signal', JSON.stringify({
      nodeId: 'node-5',
      token: 'secret',
      reachability: { status: 'direct' },
      publicAddress: 'https://node5.example',
    }));
    const response = new MockResponse() as unknown as HttpResponse;

    await handler.handle({ request, response });
    await (response as unknown as MockResponse).done;

    const call = updateNodeModeMock.mock.calls.at(-1);
    expect(call[1].accessMode).toBe('direct');
    expect(call[1].connectivityStatus).toBe('reachable');
  });

  it('switches to proxy mode when tunnel active and reachability fails', async () => {
    const handler = buildHandler(true, false);
    getNodeSecretMock.mockResolvedValueOnce({ nodeId: 'node-6', tokenHash: 'hash', metadata: {} });
    getNodeConnectivityInfoMock.mockResolvedValueOnce({
      nodeId: 'node-6',
      accessMode: 'direct',
    });

    const request = createRequest('POST', '/api/signal', JSON.stringify({
      nodeId: 'node-6',
      token: 'secret',
      reachability: { status: 'unreachable' },
      tunnel: { status: 'active', entrypoint: 'https://proxy.example' },
    }));
    const response = new MockResponse() as unknown as HttpResponse;

    await handler.handle({ request, response });
    await (response as unknown as MockResponse).done;

    const call = updateNodeModeMock.mock.calls.at(-1);
    expect(call[1].accessMode).toBe('proxy');
    expect(call[1].connectivityStatus).toBe('reachable');
  });
});
