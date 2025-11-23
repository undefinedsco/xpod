import { PassThrough } from 'node:stream';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { HttpRequest } from '@solid/community-server/dist/server/HttpRequest';
import type { HttpResponse } from '@solid/community-server/dist/server/HttpResponse';
import { NotImplementedHttpError } from '@solid/community-server/dist/util/errors/NotImplementedHttpError';
import { MethodNotAllowedHttpError } from '@solid/community-server/dist/util/errors/MethodNotAllowedHttpError';
import { UnauthorizedHttpError } from '@solid/community-server/dist/util/errors/UnauthorizedHttpError';
import { EdgeNodeCertificateHttpHandler } from '../../src/http/admin/EdgeNodeCertificateHttpHandler';

const getNodeSecretMock = vi.fn();
const matchesTokenMock = vi.fn();
const getNodeConnectivityInfoMock = vi.fn();
const issueCertificateMock = vi.fn();

class MockResponse {
  public statusCode = 200;
  public readonly headers: Record<string, any> = {};
  private readonly chunks: Buffer[] = [];
  public finished = false;

  public setHeader(name: string, value: any): void {
    this.headers[name.toLowerCase()] = value;
  }

  public end(chunk?: any): void {
    if (chunk) {
      this.chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk));
    }
    this.finished = true;
  }

  public getBody(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

function createRequest(method: string, path: string, body?: string): HttpRequest {
  const stream = new PassThrough();
  const request = stream as unknown as HttpRequest;
  // @ts-expect-error test assignment
  request.method = method;
  // @ts-expect-error test assignment
  request.url = path;
  // @ts-expect-error test assignment
  request.headers = { host: 'cluster.example' };
  request.setEncoding = (() => request) as HttpRequest['setEncoding'];
  if (body) {
    stream.end(body);
  } else {
    stream.end();
  }
  return request;
}

function buildHandler(enabled = true): EdgeNodeCertificateHttpHandler {
  return new EdgeNodeCertificateHttpHandler({
    identityDbUrl: 'postgres://test',
    edgeNodesEnabled: enabled ? 'true' : 'false',
    repository: {
      getNodeSecret: getNodeSecretMock,
      matchesToken: matchesTokenMock,
      getNodeConnectivityInfo: getNodeConnectivityInfoMock,
    } as any,
    certificateService: {
      issueCertificate: issueCertificateMock,
    } as any,
  });
}

describe('EdgeNodeCertificateHttpHandler', () => {
  beforeEach(() => {
    getNodeSecretMock.mockReset();
    matchesTokenMock.mockReset();
    getNodeConnectivityInfoMock.mockReset();
    issueCertificateMock.mockReset();
    matchesTokenMock.mockReturnValue(true);
  });

  it('拒绝禁用状态的请求', async () => {
    const handler = buildHandler(false);
    const request = createRequest('POST', '/api/signal/certificate');
    await expect(handler.canHandle({ request } as any)).rejects.toBeInstanceOf(NotImplementedHttpError);
  });

  it('只允许 POST 方法', async () => {
    const handler = buildHandler();
    const request = createRequest('GET', '/api/signal/certificate');
    await expect(handler.handle({ request, response: new MockResponse() as any })).rejects.toBeInstanceOf(MethodNotAllowedHttpError);
  });

  it('身份验证失败返回 401', async () => {
    const handler = buildHandler();
    getNodeSecretMock.mockResolvedValueOnce({ nodeId: 'node-1', tokenHash: 'hash' });
    matchesTokenMock.mockReturnValueOnce(false);
    const request = createRequest('POST', '/api/signal/certificate', JSON.stringify({ nodeId: 'node-1', token: 'bad', csr: '---csr---' }));
    await expect(handler.handle({ request, response: new MockResponse() as any })).rejects.toBeInstanceOf(UnauthorizedHttpError);
  });

  it('成功返回签发结果', async () => {
    const handler = buildHandler();
    getNodeSecretMock.mockResolvedValueOnce({ nodeId: 'node-1', tokenHash: 'hash', metadata: { subdomain: 'node-1.cluster.example' } });
    getNodeConnectivityInfoMock.mockResolvedValueOnce({ subdomain: 'node-1.cluster.example' });
    issueCertificateMock.mockResolvedValueOnce({
      certificate: 'CERT',
      fullChain: 'CHAIN',
      expiresAt: '2024-01-01T00:00:00.000Z',
      domains: [ 'node-1.cluster.example' ],
    });

    const request = createRequest('POST', '/api/signal/certificate', JSON.stringify({
      nodeId: 'node-1',
      token: 'secret',
      csr: '-----BEGIN CERTIFICATE REQUEST-----\nFAKE\n-----END CERTIFICATE REQUEST-----',
    }));
    const response = new MockResponse() as unknown as HttpResponse;

    await handler.handle({ request, response });
    expect(issueCertificateMock).toHaveBeenCalledWith({
      nodeId: 'node-1',
      csr: expect.any(String),
      subdomain: 'node-1.cluster.example',
    });

    const payload = JSON.parse((response as unknown as MockResponse).getBody());
    expect(payload.status).toBe('issued');
    expect(payload.certificate.fullChain).toBe('CHAIN');
  });
});
