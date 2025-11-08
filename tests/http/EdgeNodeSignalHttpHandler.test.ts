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

function buildHandler(enabled = true): EdgeNodeSignalHttpHandler {
  return new EdgeNodeSignalHttpHandler({
    identityDbUrl: 'postgres://test',
    edgeNodesEnabled: enabled ? 'true' : 'false',
    basePath: '/api/signal',
    repository: {
      getNodeSecret: getNodeSecretMock,
      updateNodeHeartbeat: updateNodeHeartbeatMock,
      matchesToken: matchesTokenMock,
      replaceNodePods: replaceNodePodsMock,
    } as any,
  });
}

describe('EdgeNodeSignalHttpHandler', () => {
  beforeEach(() => {
    getNodeSecretMock.mockReset();
    updateNodeHeartbeatMock.mockReset();
    matchesTokenMock.mockReset();
    replaceNodePodsMock.mockReset();
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

    await expect(handler.handle({ request, response })).rejects.toBeInstanceOf(MethodNotAllowedHttpError);
  });

  it('缺少必要字段返回 400', async () => {
    const handler = buildHandler();
    const request = createRequest('POST', '/api/signal', JSON.stringify({ nodeId: 'node-1' }));
    const response = new MockResponse() as unknown as HttpResponse;

    await expect(handler.handle({ request, response })).rejects.toBeInstanceOf(BadRequestHttpError);
  });

  it('身份验证失败返回 401', async () => {
    const handler = buildHandler();
    getNodeSecretMock.mockResolvedValueOnce({ nodeId: 'node-1', tokenHash: 'abc', metadata: {} });
    matchesTokenMock.mockReturnValueOnce(false);

    const request = createRequest('POST', '/api/signal', JSON.stringify({ nodeId: 'node-1', token: 'wrong' }));
    const response = new MockResponse() as unknown as HttpResponse;

    await expect(handler.handle({ request, response })).rejects.toBeInstanceOf(UnauthorizedHttpError);
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

    await expect(handler.handle({ request, response })).rejects.toBeInstanceOf(UnauthorizedHttpError);
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
});
