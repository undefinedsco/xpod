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
