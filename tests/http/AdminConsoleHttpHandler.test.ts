import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { HttpRequest } from '@solid/community-server/dist/server/HttpRequest';
import type { HttpResponse } from '@solid/community-server/dist/server/HttpResponse';
import type { CredentialsExtractor } from '@solid/community-server/dist/authentication/CredentialsExtractor';
import { NotImplementedHttpError } from '@solid/community-server/dist/util/errors/NotImplementedHttpError';
import { AdminConsoleHttpHandler } from '../../src/http/admin/AdminConsoleHttpHandler';

const fetchOverviewMock = vi.fn(async () => ({ accounts: [], pods: [] }));
const listNodesMock = vi.fn(async () => []);
const createNodeMock = vi.fn(async () => ({
  nodeId: 'node-1',
  token: 'token-abc',
  createdAt: new Date().toISOString(),
}));

const { createReadStreamMock, fsStatMock, fsAccessMock, fsReadFileMock } = vi.hoisted(() => ({
  createReadStreamMock: vi.fn(),
  fsStatMock: vi.fn(),
  fsAccessMock: vi.fn(),
  fsReadFileMock: vi.fn(),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    createReadStream: createReadStreamMock,
    promises: {
      ...actual.promises,
      stat: fsStatMock,
      access: fsAccessMock,
      readFile: fsReadFileMock,
    },
  };
});

vi.mock('../../src/identity/drizzle/AdminConsoleRepository', () => ({
  AdminConsoleRepository: vi.fn().mockImplementation(() => ({
    fetchOverview: fetchOverviewMock,
  })),
}));

vi.mock('../../src/identity/drizzle/EdgeNodeRepository', () => ({
  EdgeNodeRepository: vi.fn().mockImplementation(() => ({
    listNodes: listNodesMock,
    createNode: createNodeMock,
  })),
}));

vi.mock('../../src/identity/drizzle/db', () => ({
  getIdentityDatabase: vi.fn(() => ({})),
}));

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

  public writeHead(status: number, headers?: Record<string, unknown>): void {
    this.statusCode = status;
    if (headers) {
      for (const [ key, value ] of Object.entries(headers)) {
        this.setHeader(key, value as any);
      }
    }
  }
}

function createRequest(method: string, path: string, body?: string, headers: Record<string, string> = {}): HttpRequest {
  const stream = new PassThrough();
  const request = stream as unknown as HttpRequest;
  // @ts-expect-error assigning readonly fields for test doubles
  request.method = method;
  // @ts-expect-error assigning readonly fields for test doubles
  request.url = path;
  // @ts-expect-error assigning readonly fields for test doubles
  request.headers = { host: 'admin.example', ...headers };
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

function createHandler(options?: Partial<ConstructorParameters<typeof AdminConsoleHttpHandler>[0]>): AdminConsoleHttpHandler {
  const adminWebId = 'https://admin.example/profile#me';
  const credentialsExtractor = {
    handleSafe: vi.fn(async () => ({
      agent: { webId: adminWebId },
    })),
  } as unknown as CredentialsExtractor;
  const roleRepository = options?.roleRepository ?? {
    findByWebId: vi.fn(async () => ({
      accountId: 'admin-account',
      webId: adminWebId,
      roles: [ 'admin' ],
    })),
  };

  return new AdminConsoleHttpHandler({
    identityDbUrl: 'postgres://localhost/test',
    credentialsExtractor,
    edition: 'cluster',
    publicBaseUrl: 'https://pods.example.com/',
    signalEndpoint: 'wss://signal.example/register',
    edgeNodesEnabled: 'true',
    roleRepository: roleRepository as any,
    ...options,
  });
}

describe('AdminConsoleHttpHandler', () => {
  beforeEach(() => {
    fetchOverviewMock.mockClear();
    listNodesMock.mockReset();
    createNodeMock.mockReset();
    createReadStreamMock.mockReset();
    fsStatMock.mockReset();
    fsAccessMock.mockReset();
    fsReadFileMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllTimers();
  });

  it('返回配置包含 baseUrl、信令地址与功能开关', async () => {
    const handler = createHandler({ edgeNodesEnabled: 'true' });
    const request = createRequest('GET', '/admin/config');
    const response = new MockResponse() as unknown as HttpResponse;

    await handler.handle({ request, response });
    await (response as unknown as MockResponse).done;

    expect(response.statusCode).toBe(200);
    const payload = JSON.parse((response as unknown as MockResponse).getBody());
    expect(payload.edition).toBe('cluster');
    expect(payload.baseUrl).toBe('https://pods.example.com/');
    expect(payload.signalEndpoint).toBe('wss://signal.example/register');
    expect(payload.features).toEqual({ quota: true, nodes: true });
  });

  it('禁用边缘节点时访问 nodes 路由返回 501', async () => {
    const handler = createHandler({ edgeNodesEnabled: 'false' });
    const request = createRequest('GET', '/admin/nodes');
    const response = new MockResponse() as unknown as HttpResponse;

    await expect(handler.handle({ request, response })).rejects.toBeInstanceOf(NotImplementedHttpError);
  });

  it('启用时 GET /nodes 返回节点列表', async () => {
    listNodesMock.mockResolvedValueOnce([
      {
        nodeId: 'node-1',
        displayName: 'Edge A',
        podCount: 2,
        createdAt: '2024-01-01T00:00:00.000Z',
        lastSeen: '2024-01-02T00:00:00.000Z',
        metadata: { publicAddress: 'https://edge-a.example/' },
      },
    ]);
    const handler = createHandler({ edgeNodesEnabled: 'true' });
    const request = createRequest('GET', '/admin/nodes');
    const response = new MockResponse() as unknown as HttpResponse;

    await handler.handle({ request, response });
    await (response as unknown as MockResponse).done;

    expect(listNodesMock).toHaveBeenCalledTimes(1);
    expect(response.statusCode).toBe(200);
    const payload = JSON.parse((response as unknown as MockResponse).getBody());
    expect(payload.nodes).toEqual([
      {
        nodeId: 'node-1',
        displayName: 'Edge A',
        podCount: 2,
        createdAt: '2024-01-01T00:00:00.000Z',
        lastSeen: '2024-01-02T00:00:00.000Z',
        metadata: { publicAddress: 'https://edge-a.example/' },
      },
    ]);
  });

  it('启用时 POST /nodes 创建节点并返回令牌', async () => {
    const createdAt = '2024-02-01T12:00:00.000Z';
    createNodeMock.mockResolvedValueOnce({ nodeId: 'node-9', token: 'secret-token', createdAt });

    const handler = createHandler({ edgeNodesEnabled: 'true' });
    const request = createRequest(
      'POST',
      '/admin/nodes',
      JSON.stringify({ displayName: '  Shanghai Node ' }),
      { 'content-type': 'application/json' },
    );
    const response = new MockResponse() as unknown as HttpResponse;

    await handler.handle({ request, response });
    await (response as unknown as MockResponse).done;

    expect(createNodeMock).toHaveBeenCalledWith('Shanghai Node');
    expect(response.statusCode).toBe(201);
    const payload = JSON.parse((response as unknown as MockResponse).getBody());
    expect(payload).toEqual({ nodeId: 'node-9', token: 'secret-token', createdAt });
  });

  it('HEAD /config 返回 204 无正文', async () => {
    const handler = createHandler();
    const request = createRequest('HEAD', '/admin/config');
    const response = new MockResponse() as unknown as HttpResponse;

    await handler.handle({ request, response });
    await (response as unknown as MockResponse).done;

    expect(response.statusCode).toBe(204);
    expect((response as unknown as MockResponse).getBody()).toBe('');
  });

  it('HEAD /pods 返回 204', async () => {
    const handler = createHandler();
    const request = createRequest('HEAD', '/admin/pods');
    const response = new MockResponse() as unknown as HttpResponse;

    await handler.handle({ request, response });
    await (response as unknown as MockResponse).done;

    expect(response.statusCode).toBe(204);
    expect(fetchOverviewMock).not.toHaveBeenCalled();
  });


  it('GET 静态资源返回文件内容并设置缓存头', async () => {
    const stream = new PassThrough();
    createReadStreamMock.mockReturnValue(stream);
    fsStatMock.mockResolvedValue({ isDirectory: () => false });
    fsAccessMock.mockResolvedValue(undefined);

    const handler = createHandler({ staticDirectory: '/virtual/admin' });
    const request = createRequest('GET', '/admin/static/app.js');
    const response = new MockResponse() as unknown as HttpResponse;

    const scheduler = setImmediate(() => {
      stream.end('console.log("hi")');
    });

    await handler.handle({ request, response });
    await (response as unknown as MockResponse).done;

    clearImmediate(scheduler);

    expect(createReadStreamMock).toHaveBeenCalledWith(expect.stringContaining('/virtual/admin/static/app.js'));
    expect(response.statusCode).toBe(200);
    expect(response.getHeader('content-type')).toContain('application/javascript');
    expect(response.getHeader('cache-control')).toBe('public, max-age=600, immutable');
    expect((response as unknown as MockResponse).getBody()).toBe('console.log("hi")');
  });

  it('目录请求返回 index.html 并禁用缓存', async () => {
    fsStatMock.mockResolvedValueOnce({ isDirectory: () => true });
    fsAccessMock.mockResolvedValue(undefined);
    fsReadFileMock.mockResolvedValueOnce('<html></html>');

    const handler = createHandler({ staticDirectory: '/virtual/admin' });
    const request = createRequest('GET', '/admin/dashboard/');
    const response = new MockResponse() as unknown as HttpResponse;

    await handler.handle({ request, response });
    await (response as unknown as MockResponse).done;

    expect(fsReadFileMock).toHaveBeenCalledWith(expect.stringContaining('/virtual/admin/dashboard/index.html'), 'utf8');
    expect(response.statusCode).toBe(200);
    expect(response.getHeader('cache-control')).toBe('no-store');
    expect((response as unknown as MockResponse).getBody()).toBe('<html></html>');
  });

  it('HEAD 静态请求会立即销毁流', async () => {
    const stream = new PassThrough();
    const destroySpy = vi.spyOn(stream, 'destroy');
    createReadStreamMock.mockReturnValue(stream);
    fsStatMock.mockResolvedValue({ isDirectory: () => false });
    fsAccessMock.mockResolvedValue(undefined);

    const handler = createHandler({ staticDirectory: '/virtual/admin' });
    const request = createRequest('HEAD', '/admin/app.css');
    const response = new MockResponse() as unknown as HttpResponse;

    await handler.handle({ request, response });
    await (response as unknown as MockResponse).done;

    expect(destroySpy).toHaveBeenCalledTimes(1);
    expect(response.statusCode).toBe(200);
    expect((response as unknown as MockResponse).getBody()).toBe('');
  });

  it('缺失静态资源触发 NotImplemented 错误', async () => {
    fsStatMock.mockRejectedValue(new Error('missing'));
    fsAccessMock.mockRejectedValue(new Error('missing'));

    const handler = createHandler({ staticDirectory: '/virtual/admin' });
    const request = createRequest('GET', '/admin/unknown.js');
    const response = new MockResponse() as unknown as HttpResponse;

    await expect(handler.handle({ request, response })).rejects.toBeInstanceOf(NotImplementedHttpError);
  });

  it('找不到静态文件时回退至根 index.html', async () => {
    fsStatMock.mockRejectedValueOnce(new Error('missing'));
    fsAccessMock.mockResolvedValueOnce(undefined);
    fsReadFileMock.mockResolvedValueOnce('<html>fallback</html>');

    const handler = createHandler({ staticDirectory: '/virtual/admin' });
    const request = createRequest('GET', '/admin/some/asset.js');
    const response = new MockResponse() as unknown as HttpResponse;

    await handler.handle({ request, response });
    await (response as unknown as MockResponse).done;

    expect(fsReadFileMock).toHaveBeenCalledWith(expect.stringContaining('/virtual/admin/index.html'), 'utf8');
    expect(response.statusCode).toBe(200);
    expect(response.getHeader('cache-control')).toBe('no-store');
    expect((response as unknown as MockResponse).getBody()).toBe('<html>fallback</html>');
  });

  it('路径穿越请求会被拒绝且不触达文件系统', async () => {
    const handler = createHandler();
    const request = createRequest('GET', '/admin/..%2Fsecret.txt');
    const response = new MockResponse() as unknown as HttpResponse;

    await expect(handler.handle({ request, response })).rejects.toThrow('Failed to serve admin interface asset.');
    expect(fsStatMock).not.toHaveBeenCalled();
  });

  it('静态读取异常时记录内部错误', async () => {
    fsStatMock.mockResolvedValueOnce({ isDirectory: () => false });
    createReadStreamMock.mockImplementationOnce(() => {
      throw new Error('disk failure');
    });

    const handler = createHandler({ staticDirectory: '/virtual/admin' });
    const request = createRequest('GET', '/admin/app.js');
    const response = new MockResponse() as unknown as HttpResponse;

    await expect(handler.handle({ request, response })).rejects.toThrow('Failed to serve admin interface asset.');
  });

  it('非基路径请求会返回 501', async () => {
    const handler = createHandler();
    const request = createRequest('GET', '/admin-portal/ping');
    const response = new MockResponse() as unknown as HttpResponse;

    await expect(handler.handle({ request, response })).rejects.toBeInstanceOf(NotImplementedHttpError);
  });

  it('构造函数拒绝非法 basePath', () => {
    expect(() => createHandler({ basePath: 'admin' })).toThrow('Admin console base path must start with /.');
  });

  it('GET /accounts 返回账号概览', async () => {
    fetchOverviewMock.mockResolvedValueOnce({
      accounts: [{ accountId: 'acc-1', email: 'alice@example.com', createdAt: '2024-01-01T00:00:00.000Z' }],
      pods: [],
    });

    const handler = createHandler();
    const request = createRequest('GET', '/admin/accounts');
    const response = new MockResponse() as unknown as HttpResponse;

    await handler.handle({ request, response });
    await (response as unknown as MockResponse).done;

    expect(fetchOverviewMock).toHaveBeenCalledTimes(1);
    expect(response.statusCode).toBe(200);
    const payload = JSON.parse((response as unknown as MockResponse).getBody());
    expect(payload.accounts).toEqual([
      { accountId: 'acc-1', email: 'alice@example.com', createdAt: '2024-01-01T00:00:00.000Z' },
    ]);
  });

  it('HEAD /accounts 返回 204 且不读取概览', async () => {
    const handler = createHandler();
    const request = createRequest('HEAD', '/admin/accounts');
    const response = new MockResponse() as unknown as HttpResponse;

    await handler.handle({ request, response });
    await (response as unknown as MockResponse).done;

    expect(fetchOverviewMock).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(204);
    expect((response as unknown as MockResponse).getBody()).toBe('');
  });

  it('GET /pods 返回 Pod 概览', async () => {
    fetchOverviewMock.mockResolvedValueOnce({
      accounts: [],
      pods: [{ podId: 'pod-1', ownerId: 'acc-1', usage: 1024, createdAt: '2024-01-03T00:00:00.000Z' }],
    });

    const handler = createHandler();
    const request = createRequest('GET', '/admin/pods');
    const response = new MockResponse() as unknown as HttpResponse;

    await handler.handle({ request, response });
    await (response as unknown as MockResponse).done;

    expect(fetchOverviewMock).toHaveBeenCalledTimes(1);
    expect(response.statusCode).toBe(200);
    const payload = JSON.parse((response as unknown as MockResponse).getBody());
    expect(payload.pods).toEqual([
      { podId: 'pod-1', ownerId: 'acc-1', usage: 1024, createdAt: '2024-01-03T00:00:00.000Z' },
    ]);
  });

  it('HEAD /nodes 返回 204 且不读取列表', async () => {
    const handler = createHandler({ edgeNodesEnabled: 'true' });
    const request = createRequest('HEAD', '/admin/nodes');
    const response = new MockResponse() as unknown as HttpResponse;

    await handler.handle({ request, response });
    await (response as unknown as MockResponse).done;

    expect(listNodesMock).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(204);
    expect((response as unknown as MockResponse).getBody()).toBe('');
  });

  it('POST /nodes displayName 非字符串时抛出 400', async () => {
    const handler = createHandler({ edgeNodesEnabled: 'true' });
    const request = createRequest(
      'POST',
      '/admin/nodes',
      JSON.stringify({ displayName: 123 }),
      { 'content-type': 'application/json' },
    );
    const response = new MockResponse() as unknown as HttpResponse;

    await expect(handler.handle({ request, response })).rejects.toThrow('displayName 必须是字符串。');
    expect(createNodeMock).not.toHaveBeenCalled();
  });

  it('POST /nodes 仅空白名称会创建匿名节点', async () => {
    createNodeMock.mockResolvedValueOnce({ nodeId: 'node-10', token: 'token-xyz', createdAt: '2024-02-10T00:00:00.000Z' });

    const handler = createHandler({ edgeNodesEnabled: 'true' });
    const request = createRequest(
      'POST',
      '/admin/nodes',
      JSON.stringify({ displayName: '   ' }),
      { 'content-type': 'application/json' },
    );
    const response = new MockResponse() as unknown as HttpResponse;

    await handler.handle({ request, response });
    await (response as unknown as MockResponse).done;

    expect(createNodeMock).toHaveBeenCalledWith(undefined);
    expect(response.statusCode).toBe(201);
    const payload = JSON.parse((response as unknown as MockResponse).getBody());
    expect(payload).toEqual({ nodeId: 'node-10', token: 'token-xyz', createdAt: '2024-02-10T00:00:00.000Z' });
  });

  it('POST /nodes 非法 JSON 抛出 400', async () => {
    const handler = createHandler({ edgeNodesEnabled: 'true' });
    const request = createRequest(
      'POST',
      '/admin/nodes',
      '{"displayName":',
      { 'content-type': 'application/json' },
    );
    const response = new MockResponse() as unknown as HttpResponse;

    await expect(handler.handle({ request, response })).rejects.toThrow('请求体必须是有效的 JSON。');
    expect(createNodeMock).not.toHaveBeenCalled();
  });

  it('OPTIONS 请求返回允许的方法列表', async () => {
    const handler = createHandler();
    const request = createRequest('OPTIONS', '/admin/config');
    const response = new MockResponse() as unknown as HttpResponse;

    await handler.handle({ request, response });
    await (response as unknown as MockResponse).done;

    expect(response.statusCode).toBe(204);
    expect(response.getHeader('allow')).toBe('GET,HEAD,POST,OPTIONS');
  });
});
