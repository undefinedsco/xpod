import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { HttpRequest } from '@solid/community-server/dist/server/HttpRequest';
import type { HttpResponse } from '@solid/community-server/dist/server/HttpResponse';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { NotImplementedHttpError } from '@solid/community-server/dist/util/errors/NotImplementedHttpError';
import { EdgeNodeRedirectHttpHandler } from '../../src/http/EdgeNodeRedirectHttpHandler';

const findNodeMock = vi.fn();

class MockResponse extends EventEmitter {
  public statusCode = 200;
  public readonly headers: Record<string, any> = {};
  public finished = false;

  public setHeader(name: string, value: any): void {
    this.headers[name.toLowerCase()] = value;
  }

  public end(): void {
    this.finished = true;
  }
}

function createRequest(method: string, path: string): HttpRequest {
  const stream = new PassThrough();
  const request = stream as unknown as HttpRequest;
  // @ts-expect-error test double assignment
  request.method = method;
  // @ts-expect-error test double assignment
  request.url = path;
  // @ts-expect-error test double assignment
  request.headers = { host: 'pods.example.com' };
  return request;
}

function buildHandler(enabled = true): EdgeNodeRedirectHttpHandler {
  return new EdgeNodeRedirectHttpHandler({
    identityDbUrl: 'postgres://test',
    edgeNodesEnabled: enabled ? 'true' : 'false',
    nodeRepository: { findNodeByResourcePath: findNodeMock } as any,
  });
}

describe('EdgeNodeRedirectHttpHandler', () => {
  beforeEach(() => {
    findNodeMock.mockReset();
  });

  it('禁用时跳过处理', async () => {
    const handler = buildHandler(false);
    const request = createRequest('GET', '/alice/profile/');
    await expect(handler.canHandle({ request } as any)).rejects.toBeInstanceOf(NotImplementedHttpError);
  });

  it('未知 Pod 返回 NotImplemented', async () => {
    const handler = buildHandler();
    findNodeMock.mockResolvedValueOnce(undefined);
    const request = createRequest('GET', '/bob/profile/card');
    await expect(handler.canHandle({ request } as any)).rejects.toBeInstanceOf(NotImplementedHttpError);
  });

  it('节点缺少元数据时不重定向', async () => {
    const handler = buildHandler();
    findNodeMock.mockResolvedValueOnce({
      nodeId: 'node-1',
      baseUrl: 'https://pods.example.com/alice/',
      metadata: null,
    });

    const request = createRequest('GET', '/alice/profile/card');
    await expect(handler.canHandle({ request } as any)).rejects.toBeInstanceOf(NotImplementedHttpError);
  });

  it('成功返回 307 重定向', async () => {
    const handler = buildHandler();
    findNodeMock.mockResolvedValue({
      nodeId: 'node-9',
      baseUrl: 'https://pods.example.com/alice/',
      metadata: { publicAddress: 'https://edge-1.example:8443/' },
    });

    const request = createRequest('GET', '/alice/profile/card?version=1');
    const response = new MockResponse() as unknown as HttpResponse;
    await handler.handle({ request, response });

    expect(response.statusCode).toBe(307);
    expect(response.headers.location).toBe('https://edge-1.example:8443/profile/card?version=1');
    expect(response.headers['x-xpod-edge-node']).toBe('node-9');
  });

  it('pod 基路径不匹配时跳过', async () => {
    const handler = buildHandler();
    findNodeMock.mockResolvedValueOnce({
      nodeId: 'node-9',
      baseUrl: 'https://pods.example.com/alice/',
      metadata: { baseUrl: 'https://edge-1.example' },
    });

    const request = createRequest('GET', '/bob/profile/');
    await expect(handler.handle({ request, response: new MockResponse() as unknown as HttpResponse })).rejects.toBeInstanceOf(NotImplementedHttpError);
  });
});
