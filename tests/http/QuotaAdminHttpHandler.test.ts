import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { HttpRequest } from '@solid/community-server/dist/server/HttpRequest';
import type { HttpResponse } from '@solid/community-server/dist/server/HttpResponse';
import { NotImplementedHttpError } from '@solid/community-server/dist/util/errors/NotImplementedHttpError';
import { UnauthorizedHttpError } from '@solid/community-server/dist/util/errors/UnauthorizedHttpError';
import { ForbiddenHttpError } from '@solid/community-server/dist/util/errors/ForbiddenHttpError';
import { BadRequestHttpError } from '@solid/community-server/dist/util/errors/BadRequestHttpError';
import { MethodNotAllowedHttpError } from '@solid/community-server/dist/util/errors/MethodNotAllowedHttpError';
import { QuotaAdminHttpHandler } from '../../src/http/quota/QuotaAdminHttpHandler';

const verifyMock = vi.fn();
const accountRepoInstances: Array<{ getPodInfo: ReturnType<typeof vi.fn> }> = [];
const quotaServiceInstances: Array<{
  getAccountLimit: ReturnType<typeof vi.fn>;
  getPodLimit: ReturnType<typeof vi.fn>;
  setAccountLimit: ReturnType<typeof vi.fn>;
  setPodLimit: ReturnType<typeof vi.fn>;
}> = [];

vi.mock('@solid/access-token-verifier', () => ({
  createSolidTokenVerifier: vi.fn(() => verifyMock),
}));

vi.mock('../../src/identity/drizzle/AccountRepository', () => ({
  AccountRepository: vi.fn().mockImplementation(() => {
    const instance = {
      getPodInfo: vi.fn(),
    };
    accountRepoInstances.push(instance);
    return instance;
  }),
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
}

function createRequest(method: string, path: string, body?: string, headers: Record<string, string> = {}): HttpRequest {
  const stream = new PassThrough();
  const request = stream as unknown as HttpRequest;
  // @ts-expect-error test double assignment
  request.method = method;
  // @ts-expect-error test double assignment
  request.url = path;
  // @ts-expect-error test double assignment
  request.headers = { host: 'quota.example', ...headers };
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

function getLastAccountRepo() {
  if (accountRepoInstances.length === 0) {
    throw new Error('AccountRepository 未被实例化');
  }
  return accountRepoInstances[accountRepoInstances.length - 1];
}

function getLastQuotaService() {
  if (quotaServiceInstances.length === 0) {
    throw new Error('QuotaService 未被实例化');
  }
  return quotaServiceInstances[quotaServiceInstances.length - 1];
}

function createQuotaService() {
  const service = {
    getAccountLimit: vi.fn(),
    getPodLimit: vi.fn(),
    setAccountLimit: vi.fn(),
    setPodLimit: vi.fn(),
  };
  quotaServiceInstances.push(service);
  return service;
}

function createHandler(options: Partial<ConstructorParameters<typeof QuotaAdminHttpHandler>[0]> = {}) {
  const adminWebId = 'https://admin.example/profile#me';
  const roleRepository = options.roleRepository ?? {
    findByWebId: vi.fn(async () => ({ accountId: 'admin-account', webId: adminWebId, roles: [ 'admin' ] })),
  };
  const quotaService = options.quotaService ?? createQuotaService();
  const handler = new QuotaAdminHttpHandler({
    identityDbUrl: 'postgres://localhost/test',
    basePath: '/api/quota/',
    roleRepository: roleRepository as any,
    quotaService,
    ...options,
  });
  return { handler, quotaService };
}

describe('QuotaAdminHttpHandler', () => {
  beforeEach(() => {
    verifyMock.mockReset();
    accountRepoInstances.splice(0, accountRepoInstances.length);
    quotaServiceInstances.splice(0, quotaServiceInstances.length);
    verifyMock.mockResolvedValue({ webid: 'https://admin.example/profile#me' });
  });

  it('识别非配额路径时 canHandle 抛出 501', async () => {
    const { handler } = createHandler();
    const request = createRequest('GET', '/admin/config');

    await expect(handler.canHandle({ request } as any)).rejects.toBeInstanceOf(NotImplementedHttpError);
  });

  it('配额路径 canHandle 成功', async () => {
    const { handler } = createHandler();
    const request = createRequest('GET', '/api/quota/accounts/acc-1');

    await expect(handler.canHandle({ request } as any)).resolves.toBeUndefined();
  });

  it('OPTIONS 请求返回允许的方法列表', async () => {
    const { handler } = createHandler();
    const request = createRequest('OPTIONS', '/api/quota/accounts/acc-1');
    const response = new MockResponse() as unknown as HttpResponse;

    await handler.handle({ request, response });
    await (response as unknown as MockResponse).done;

    expect(response.statusCode).toBe(204);
    expect(response.getHeader('allow')).toBe('GET,PUT,DELETE,OPTIONS');
  });

  it('缺少 Bearer Token 返回 401', async () => {
    const { handler } = createHandler();
    const request = createRequest('GET', '/api/quota/accounts/acc-1');
    const response = new MockResponse() as unknown as HttpResponse;

    await expect(handler.handle({ request, response })).rejects.toBeInstanceOf(UnauthorizedHttpError);
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it('校验失败的 Token 抛出 401', async () => {
    verifyMock.mockRejectedValueOnce(new Error('bad token'));
    const { handler } = createHandler();
    const request = createRequest('GET', '/api/quota/accounts/acc-1', undefined, { authorization: 'Bearer invalid' });
    const response = new MockResponse() as unknown as HttpResponse;

    await expect(handler.handle({ request, response })).rejects.toBeInstanceOf(UnauthorizedHttpError);
    expect(verifyMock).toHaveBeenCalledWith('Bearer invalid');
  });

  it('非管理员返回 403', async () => {
    verifyMock.mockResolvedValueOnce({ webid: 'https://user.example/profile#me' });
    const { handler } = createHandler({
      roleRepository: {
        findByWebId: vi.fn(async () => ({ accountId: 'user-account', webId: 'https://user.example/profile#me', roles: [] })),
      } as any,
    });
    const request = createRequest('GET', '/api/quota/accounts/acc-1', undefined, { authorization: 'Bearer good' });
    const response = new MockResponse() as unknown as HttpResponse;

    await expect(handler.handle({ request, response })).rejects.toBeInstanceOf(ForbiddenHttpError);
  });

  it('GET /accounts/{id} 返回账户配额', async () => {
    const { handler, quotaService } = createHandler();
    const request = createRequest('GET', '/api/quota/accounts/acc-1', undefined, { authorization: 'Bearer good' });
    const response = new MockResponse() as unknown as HttpResponse;
    quotaService.getAccountLimit.mockResolvedValueOnce(2_048);

    await handler.handle({ request, response });
    await (response as unknown as MockResponse).done;

    expect(response.statusCode).toBe(200);
    expect(JSON.parse((response as unknown as MockResponse).getBody())).toEqual({
      type: 'account',
      accountId: 'acc-1',
      quotaLimit: 2_048,
    });
  });

  it('GET /pods/{id} 返回 Pod 配额信息', async () => {
    const { handler, quotaService } = createHandler();
    const request = createRequest('GET', '/api/quota/pods/pod-1', undefined, { authorization: 'Bearer good' });
    const response = new MockResponse() as unknown as HttpResponse;
    const repo = getLastAccountRepo();
    repo.getPodInfo.mockResolvedValueOnce({ accountId: 'acc-1', baseUrl: 'https://pods.example.com/alice/' });
    quotaService.getPodLimit.mockResolvedValueOnce(1_024);

    await handler.handle({ request, response });
    await (response as unknown as MockResponse).done;

    expect(response.statusCode).toBe(200);
    expect(JSON.parse((response as unknown as MockResponse).getBody())).toEqual({
      type: 'pod',
      podId: 'pod-1',
      accountId: 'acc-1',
      baseUrl: 'https://pods.example.com/alice/',
      quotaLimit: 1_024,
    });
  });

  it('PUT /accounts/{id} 更新配额', async () => {
    const { handler, quotaService } = createHandler();
    const request = createRequest('PUT', '/api/quota/accounts/acc-2', JSON.stringify({ quotaLimit: 512 }), {
      authorization: 'Bearer good',
      'content-type': 'application/json',
    });
    const response = new MockResponse() as unknown as HttpResponse;
    quotaService.setAccountLimit.mockResolvedValueOnce(undefined);
    quotaService.getAccountLimit.mockResolvedValueOnce(512);

    await handler.handle({ request, response });
    await (response as unknown as MockResponse).done;

    expect(quotaService.setAccountLimit).toHaveBeenCalledWith('acc-2', 512);
    expect(response.statusCode).toBe(200);
    expect(JSON.parse((response as unknown as MockResponse).getBody()).quotaLimit).toBe(512);
  });

  it('PUT /pods/{id} quotaLimit 为 null 时清除配额', async () => {
    const { handler, quotaService } = createHandler();
    const request = createRequest('PUT', '/api/quota/pods/pod-2', JSON.stringify({ quotaLimit: null }), {
      authorization: 'Bearer good',
      'content-type': 'application/json',
    });
    const response = new MockResponse() as unknown as HttpResponse;
    const repo = getLastAccountRepo();
    repo.getPodInfo.mockResolvedValueOnce({ accountId: 'acc-2', baseUrl: 'https://pods.example.com/bob/' });
    quotaService.setPodLimit.mockResolvedValueOnce(undefined);
    quotaService.getPodLimit.mockResolvedValueOnce(null);

    await handler.handle({ request, response });
    await (response as unknown as MockResponse).done;

    expect(quotaService.setPodLimit).toHaveBeenCalledWith('pod-2', null);
    expect(response.statusCode).toBe(200);
    expect(JSON.parse((response as unknown as MockResponse).getBody()).quotaLimit).toBe(null);
  });

  it('DELETE /accounts/{id} 清除配额', async () => {
    const { handler, quotaService } = createHandler();
    const request = createRequest('DELETE', '/api/quota/accounts/acc-3', undefined, { authorization: 'Bearer good' });
    const response = new MockResponse() as unknown as HttpResponse;
    quotaService.setAccountLimit.mockResolvedValueOnce(undefined);

    await handler.handle({ request, response });
    await (response as unknown as MockResponse).done;

    expect(quotaService.setAccountLimit).toHaveBeenCalledWith('acc-3', null);
    expect(response.statusCode).toBe(200);
  });

  it('DELETE /pods/{id} 清除配额', async () => {
    const { handler, quotaService } = createHandler();
    const request = createRequest('DELETE', '/api/quota/pods/pod-4', undefined, { authorization: 'Bearer good' });
    const response = new MockResponse() as unknown as HttpResponse;
    const repo = getLastAccountRepo();
    repo.getPodInfo.mockResolvedValueOnce({ accountId: 'acc-4', baseUrl: 'https://pods.example.com/carl/' });
    quotaService.setPodLimit.mockResolvedValueOnce(undefined);

    await handler.handle({ request, response });
    await (response as unknown as MockResponse).done;

    expect(quotaService.setPodLimit).toHaveBeenCalledWith('pod-4', null);
    expect(response.statusCode).toBe(200);
  });

  it('自定义角色仓储返回管理员时请求成功', async () => {
    const { handler } = createHandler({
      roleRepository: {
        findByWebId: vi.fn(async () => ({ accountId: 'custom-admin', roles: [ 'admin' ] })),
      } as any,
    });
    const request = createRequest('GET', '/api/quota/accounts/acc-5', undefined, { authorization: 'Bearer custom' });
    const response = new MockResponse() as unknown as HttpResponse;

    await handler.handle({ request, response });
    await (response as unknown as MockResponse).done;

    expect(response.statusCode).toBe(200);
  });

  it('GET 账户未设置配额返回 null', async () => {
    const { handler, quotaService } = createHandler();
    const request = createRequest('GET', '/api/quota/accounts/acc-6', undefined, { authorization: 'Bearer good' });
    const response = new MockResponse() as unknown as HttpResponse;
    quotaService.getAccountLimit.mockResolvedValueOnce(undefined);

    await handler.handle({ request, response });
    await (response as unknown as MockResponse).done;

    expect(JSON.parse((response as unknown as MockResponse).getBody()).quotaLimit).toBeNull();
  });

  it('未知 Pod 标识返回 400', async () => {
    const { handler } = createHandler();
    const request = createRequest('PUT', '/api/quota/pods/ghost', JSON.stringify({ quotaLimit: 10 }), {
      authorization: 'Bearer good',
      'content-type': 'application/json',
    });
    const response = new MockResponse() as unknown as HttpResponse;
    const repo = getLastAccountRepo();
    repo.getPodInfo.mockResolvedValueOnce(undefined);

    await expect(handler.handle({ request, response })).rejects.toBeInstanceOf(BadRequestHttpError);
  });

  it('非 GET/PUT/DELETE 方法抛出 405', async () => {
    const { handler } = createHandler();
    const request = createRequest('POST', '/api/quota/accounts/acc-7', '{}', {
      authorization: 'Bearer good',
      'content-type': 'application/json',
    });
    const response = new MockResponse() as unknown as HttpResponse;

    await expect(handler.handle({ request, response })).rejects.toBeInstanceOf(MethodNotAllowedHttpError);
  });
});
