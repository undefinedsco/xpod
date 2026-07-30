import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { ApiServer } from '../../../src/api/ApiServer';
import type { AuthenticatedRequest } from '../../../src/api/middleware/AuthMiddleware';
import { registerPodSettingsRoutes } from '../../../src/api/handlers/PodSettingsHandler';

const WEB_ID = 'https://pod.example/alice/profile/card#me';
const OTHER_WEB_ID = 'https://pod.example/bob/profile/card#me';

function createServer(): { server: ApiServer; routes: Record<string, Function> } {
  const routes: Record<string, Function> = {};
  return {
    routes,
    server: {
      get: vi.fn((path: string, handler: Function) => { routes[`GET ${path}`] = handler; }),
    } as unknown as ApiServer,
  };
}

function request(auth: AuthenticatedRequest['auth']): AuthenticatedRequest {
  const req = new PassThrough() as PassThrough & AuthenticatedRequest;
  req.method = 'GET';
  req.url = '/api/pod/settings/status?webId=https%3A%2F%2Fevil.example%2Fme';
  req.headers = {};
  req.auth = auth;
  req.end();
  return req;
}

function response(): any {
  return {
    statusCode: 0,
    headers: {} as Record<string, string>,
    setHeader(name: string, value: string) {
      this.headers[name.toLowerCase()] = value;
    },
    end: vi.fn(function(this: any, payload?: string) {
      this.body = payload;
    }),
  };
}

describe('PodSettingsHandler', () => {
  it('requires Solid authentication and derives lookup only from the authenticated WebID', async () => {
    const { server, routes } = createServer();
    const podLookupRepository = {
      findByWebId: vi.fn(async () => ({
        podId: 'pod-alice',
        accountId: 'acc-alice',
        baseUrl: 'https://pod.example/alice/',
        storageUrl: 'https://pod.example/alice/',
        webId: WEB_ID,
      })),
    };
    const usageRepo = {
      getPodUsage: vi.fn(async () => ({
        podId: 'pod-alice',
        accountId: 'acc-alice',
        storageBytes: 1024,
        ingressBytes: 64,
        egressBytes: 128,
        storageLimitBytes: 4096,
        bandwidthLimitBps: null,
        computeSeconds: 0,
        tokensUsed: 0,
      })),
    };

    registerPodSettingsRoutes(server, {
      podLookupRepository,
      usageRepo,
      aiConnectionStatusReader: {
        read: vi.fn(async (webId: string) => ({
          status: 'available',
          configuredProviders: 1,
          lastSyncAt: '2026-07-31T00:00:00.000Z',
          source: 'drizzle-solid',
        })),
      },
      now: () => new Date('2026-07-31T00:01:00.000Z'),
    });

    const unauthenticated = response();
    await routes['GET /api/pod/settings/status'](request(undefined), unauthenticated, {});
    expect(unauthenticated.statusCode).toBe(401);

    const res = response();
    await routes['GET /api/pod/settings/status'](request({ type: 'solid', webId: WEB_ID }), res, {});

    expect(podLookupRepository.findByWebId).toHaveBeenCalledWith(WEB_ID);
    expect(podLookupRepository.findByWebId).not.toHaveBeenCalledWith(OTHER_WEB_ID);
    expect(usageRepo.getPodUsage).toHaveBeenCalledWith('pod-alice');
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      identity: { webId: WEB_ID, podUrl: 'https://pod.example/alice/' },
      storage: {
        status: 'available',
        usage: { storageBytes: 1024, ingressBytes: 64, egressBytes: 128 },
        limits: { storageLimitBytes: 4096, bandwidthLimitBps: null },
      },
      aiConnection: {
        status: 'available',
        configuredProviders: 1,
      },
      generatedAt: '2026-07-31T00:01:00.000Z',
    });
    expect(res.body).not.toContain('evil.example');
  });

  it('reports unsupported usage without manufacturing zero values', async () => {
    const { server, routes } = createServer();
    registerPodSettingsRoutes(server, {
      podLookupRepository: {
        findByWebId: vi.fn(async () => ({
          podId: 'pod-alice',
          accountId: 'acc-alice',
          baseUrl: 'https://pod.example/alice/',
          webId: WEB_ID,
        })),
      },
      usageRepo: {
        getPodUsage: vi.fn(async () => undefined),
      },
      aiConnectionStatusReader: {
        read: vi.fn(async () => ({ status: 'unsupported', reason: 'not_configured' })),
      },
    });
    const res = response();

    await routes['GET /api/pod/settings/status'](request({ type: 'solid', webId: WEB_ID }), res, {});

    const body = JSON.parse(res.body);
    expect(body.storage).toEqual({ status: 'unsupported', reason: 'usage_not_available' });
    expect(JSON.stringify(body.storage)).not.toContain('storageBytes');
  });
});
