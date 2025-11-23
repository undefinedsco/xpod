import { PassThrough, Writable } from 'node:stream';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { HttpResponse } from '@solid/community-server/dist/server/HttpResponse';
import { NotImplementedHttpError } from '@solid/community-server/dist/util/errors/NotImplementedHttpError';
import { EdgeNodeProxyHttpHandler } from '../../src/http/EdgeNodeProxyHttpHandler';

const findNodeBySubdomainMock = vi.fn();

class MockResponse extends Writable {
  public statusCode = 200;
  public readonly headers: Record<string, any> = {};
  private readonly chunks: Buffer[] = [];

  public setHeader(name: string, value: any): void {
    this.headers[name.toLowerCase()] = value;
  }

  public _write(chunk: any, _encoding: string, callback: () => void): void {
    this.chunks.push(Buffer.from(chunk));
    callback();
  }

  public getBody(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

function createRequest(method: string, host: string, path = '/'): PassThrough {
  const stream = new PassThrough();
  // @ts-expect-error test
  stream.method = method;
  // @ts-expect-error test
  stream.url = path;
  // @ts-expect-error test
  stream.headers = { host };
  process.nextTick(() => stream.end());
  return stream;
}

function buildHandler(enabled = true, fetchImpl?: typeof fetch): EdgeNodeProxyHttpHandler {
  return new EdgeNodeProxyHttpHandler({
    identityDbUrl: 'postgres://test',
    edgeNodesEnabled: enabled ? 'true' : 'false',
    repository: {
      findNodeBySubdomain: findNodeBySubdomainMock,
    } as any,
    fetchImpl,
  });
}

describe('EdgeNodeProxyHttpHandler', () => {
  beforeEach(() => {
    findNodeBySubdomainMock.mockReset();
  });

  it('skips when disabled', async () => {
    const handler = buildHandler(false);
    const request = createRequest('GET', 'node.cluster.example');
    await expect(handler.canHandle({ request } as any)).rejects.toBeInstanceOf(NotImplementedHttpError);
  });

  it('forwards proxy requests to upstream', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response('ok', {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    }));
    const handler = buildHandler(true, fetchSpy as any);
    findNodeBySubdomainMock.mockResolvedValueOnce({
      nodeId: 'node-1',
      accessMode: 'proxy',
      metadata: {
        tunnel: {
          entrypoint: 'https://proxy-internal.example/node-1/',
        },
      },
    });
    const request = createRequest('GET', 'node.cluster.example', '/foo');
    const response = new MockResponse();
    const finished = new Promise((resolve) => response.on('finish', resolve));

    await handler.handle({ request, response: response as unknown as HttpResponse });
    await finished;

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://proxy-internal.example/foo',
      expect.objectContaining({ method: 'GET' })
    );
    expect(response.getBody()).toBe('ok');
  });
});
