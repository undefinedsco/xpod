import { describe, expect, it, vi } from 'vitest';
import type { ApiServer, RouteHandler } from '../../../src/api/ApiServer';
import { registerUsageRoutes } from '../../../src/api/handlers/UsageHandler';

describe('registerUsageRoutes account authorization', () => {
  it('allows the authenticated account to read only its own usage', async () => {
    const handler = captureHandler();
    const usageRepo = {
      getAccountUsage: vi.fn(async (accountId: string) => ({
        accountId,
        storageBytes: 10,
        ingressBytes: 20,
        egressBytes: 30,
        computeSeconds: 40,
        tokensUsed: 50,
        periodStart: null,
      })),
    };
    registerUsageRoutes(handler.server, { usageRepo: usageRepo as never });

    const ownResponse = createResponse();
    await handler.routes.get('/v1/usage/accounts/:accountId')?.({
      auth: { type: 'account', accountId: 'account-1', tokenType: 'CSS-Account-Token' },
    } as never, ownResponse as never, { accountId: 'account-1' });
    expect(ownResponse.statusCode).toBe(200);
    expect(JSON.parse(ownResponse.body)).toMatchObject({ accountId: 'account-1' });

    const otherResponse = createResponse();
    await handler.routes.get('/v1/usage/accounts/:accountId')?.({
      auth: { type: 'account', accountId: 'account-1', tokenType: 'CSS-Account-Token' },
    } as never, otherResponse as never, { accountId: 'account-2' });
    expect(otherResponse.statusCode).toBe(403);
    expect(usageRepo.getAccountUsage).toHaveBeenCalledTimes(1);
  });

  it('uses explicit Solid ownership to deny other accounts and pods without reading usage', async () => {
    const handler = captureHandler();
    const usageRepo = {
      getAccountUsage: vi.fn(async (accountId: string) => ({
        accountId,
        storageBytes: 10,
        ingressBytes: 20,
        egressBytes: 30,
        computeSeconds: 40,
        tokensUsed: 50,
        periodStart: null,
      })),
      getPodUsage: vi.fn(async (podId: string) => ({
        podId,
        accountId: 'account-a',
        storageBytes: 11,
        ingressBytes: 21,
        egressBytes: 31,
        computeSeconds: 41,
        tokensUsed: 51,
        periodStart: null,
      })),
    };
    const ownershipResolver = {
      ownsAccount: vi.fn(async ({ webId, accountId }: { webId: string; accountId: string }) => (
        webId === 'webid-a' && accountId === 'account-a'
      )),
      ownsPod: vi.fn(async ({ webId, podId }: { webId: string; podId: string }) => (
        webId === 'webid-a' && podId === 'pod-a'
      )),
    };
    registerUsageRoutes(handler.server, { usageRepo: usageRepo as never, ownershipResolver });

    const accountDenied = createResponse();
    await handler.routes.get('/v1/usage/accounts/:accountId')?.({
      auth: { type: 'solid', webId: 'webid-a' },
    } as never, accountDenied as never, { accountId: 'account-b' });
    expect(accountDenied.statusCode).toBe(403);
    expect(usageRepo.getAccountUsage).not.toHaveBeenCalled();

    const podDenied = createResponse();
    await handler.routes.get('/v1/usage/pods/:podId')?.({
      auth: { type: 'solid', webId: 'webid-a' },
    } as never, podDenied as never, { podId: 'pod-b' });
    expect(podDenied.statusCode).toBe(403);
    expect(usageRepo.getPodUsage).not.toHaveBeenCalled();

    const ownPod = createResponse();
    await handler.routes.get('/v1/usage/pods/:podId')?.({
      auth: { type: 'solid', webId: 'webid-a' },
    } as never, ownPod as never, { podId: 'pod-a' });
    expect(ownPod.statusCode).toBe(200);
    expect(usageRepo.getPodUsage).toHaveBeenCalledWith('pod-a');
  });

  it('allows a scoped service to read any account and pod usage', async () => {
    const handler = captureHandler();
    const usageRepo = {
      getAccountUsage: vi.fn(async () => undefined),
      getPodUsage: vi.fn(async () => undefined),
    };
    registerUsageRoutes(handler.server, { usageRepo: usageRepo as never });

    const accountResponse = createResponse();
    await handler.routes.get('/v1/usage/accounts/:accountId')?.({
      auth: { type: 'service', serviceType: 'cloud', serviceId: 'cloud-1', scopes: ['usage:read'] },
    } as never, accountResponse as never, { accountId: 'account-b' });
    expect(accountResponse.statusCode).toBe(200);

    const podResponse = createResponse();
    await handler.routes.get('/v1/usage/pods/:podId')?.({
      auth: { type: 'service', serviceType: 'cloud', serviceId: 'cloud-1', scopes: ['usage:read'] },
    } as never, podResponse as never, { podId: 'pod-b' });
    expect(podResponse.statusCode).toBe(404);
    expect(usageRepo.getAccountUsage).toHaveBeenCalledWith('account-b');
    expect(usageRepo.getPodUsage).toHaveBeenCalledWith('pod-b');
  });

  it('fails closed for Solid usage when no ownership resolver is configured', async () => {
    const handler = captureHandler();
    const usageRepo = {
      getAccountUsage: vi.fn(async () => undefined),
      getPodUsage: vi.fn(async () => undefined),
    };
    registerUsageRoutes(handler.server, { usageRepo: usageRepo as never });

    const accountResponse = createResponse();
    await handler.routes.get('/v1/usage/accounts/:accountId')?.({
      auth: { type: 'solid', webId: 'webid-a' },
    } as never, accountResponse as never, { accountId: 'account-a' });
    expect(accountResponse.statusCode).toBe(403);

    const podResponse = createResponse();
    await handler.routes.get('/v1/usage/pods/:podId')?.({
      auth: { type: 'solid', webId: 'webid-a' },
    } as never, podResponse as never, { podId: 'pod-a' });
    expect(podResponse.statusCode).toBe(403);
    expect(usageRepo.getAccountUsage).not.toHaveBeenCalled();
    expect(usageRepo.getPodUsage).not.toHaveBeenCalled();
  });
});

function captureHandler() {
  const routes = new Map<string, RouteHandler>();
  const server = {
    get: vi.fn((path: string, route: RouteHandler) => routes.set(path, route)),
  } as unknown as ApiServer;
  return { server, routes };
}

function createResponse() {
  return {
    statusCode: 0,
    body: '',
    setHeader: vi.fn(),
    end(value?: string) {
      this.body = value ?? '';
    },
  };
}
