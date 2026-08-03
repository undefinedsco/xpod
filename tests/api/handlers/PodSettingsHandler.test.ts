import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { ApiServer } from '../../../src/api/ApiServer';
import type { AuthenticatedRequest } from '../../../src/api/middleware/AuthMiddleware';
import {
  DrizzlePodAiConnectionStatusReader,
  registerPodSettingsRoutes,
} from '../../../src/api/handlers/PodSettingsHandler';

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
    const aiReader = {
      read: vi.fn(async () => ({
        status: 'available' as const,
        configuredProviders: 1,
        lastSyncAt: '2026-07-31T00:00:00.000Z',
        source: 'drizzle-solid' as const,
      })),
    };

    registerPodSettingsRoutes(server, {
      podLookupRepository,
      usageRepo,
      aiConnectionStatusReader: aiReader,
      now: () => new Date('2026-07-31T00:01:00.000Z'),
    });

    const unauthenticated = response();
    await routes['GET /api/pod/settings/status'](request(undefined), unauthenticated, {});
    expect(unauthenticated.statusCode).toBe(401);

    const res = response();
    const auth = { type: 'solid' as const, webId: WEB_ID, accessToken: 'solid-token' };
    await routes['GET /api/pod/settings/status'](request(auth), res, {});

    expect(podLookupRepository.findByWebId).toHaveBeenCalledWith(WEB_ID);
    expect(podLookupRepository.findByWebId).not.toHaveBeenCalledWith(OTHER_WEB_ID);
    expect(usageRepo.getPodUsage).toHaveBeenCalledWith('pod-alice');
    expect(aiReader.read).toHaveBeenCalledWith({
      webId: WEB_ID,
      podUrl: 'https://pod.example/alice/',
      auth,
    });
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
        read: vi.fn(async () => ({ status: 'unsupported' as const, reason: 'not_configured' })),
      },
    });
    const res = response();

    await routes['GET /api/pod/settings/status'](request({ type: 'solid', webId: WEB_ID }), res, {});

    const body = JSON.parse(res.body);
    expect(body.storage).toEqual({ status: 'unsupported', reason: 'usage_not_available' });
    expect(JSON.stringify(body.storage)).not.toContain('storageBytes');
  });

  it('passes split IdP and SP storage URL to the AI reader', async () => {
    const { server, routes } = createServer();
    const aiReader = {
      read: vi.fn(async () => ({
        status: 'available' as const,
        configuredProviders: 0,
        containerUrl: 'https://storage.example/alice/settings/credentials.ttl',
        source: 'drizzle-solid' as const,
      })),
    };
    registerPodSettingsRoutes(server, {
      podLookupRepository: {
        findByWebId: vi.fn(async () => ({
          podId: 'pod-split',
          accountId: 'acc-split',
          baseUrl: 'https://storage.example/alice/',
          storageUrl: 'https://storage.example/alice/',
          webId: 'https://id.example/alice/profile/card#me',
        })),
      },
      usageRepo: {
        getPodUsage: vi.fn(async () => undefined),
      },
      aiConnectionStatusReader: aiReader,
    });
    const res = response();

    const auth = {
      type: 'solid',
      webId: 'https://id.example/alice/profile/card#me',
      accessToken: 'split-token',
    } as const;
    await routes['GET /api/pod/settings/status'](request(auth), res, {});

    expect(aiReader.read).toHaveBeenCalledWith({
      webId: 'https://id.example/alice/profile/card#me',
      podUrl: 'https://storage.example/alice/',
      auth,
    });
    expect(JSON.parse(res.body)).toMatchObject({
      identity: {
        webId: 'https://id.example/alice/profile/card#me',
        podUrl: 'https://storage.example/alice/',
      },
      aiConnection: {
        containerUrl: 'https://storage.example/alice/settings/credentials.ttl',
      },
    });
  });

  it('maps AI reader failures to sanitized categories without leaking URLs or secrets', async () => {
    const { server, routes } = createServer();
    const logger = { warn: vi.fn(), error: vi.fn() };
    registerPodSettingsRoutes(server, {
      podLookupRepository: {
        findByWebId: vi.fn(async () => ({
          podId: 'pod-alice',
          accountId: 'acc-alice',
          baseUrl: 'https://storage.example/alice/',
          storageUrl: 'https://storage.example/alice/',
          webId: WEB_ID,
        })),
      },
      usageRepo: {
        getPodUsage: vi.fn(async () => undefined),
      },
      aiConnectionStatusReader: {
        read: vi.fn(async () => {
          throw new Error('403 service_access_missing https://storage.example/alice/settings/credentials.ttl token=secret');
        }),
      },
      logger,
    });
    const res = response();

    await routes['GET /api/pod/settings/status'](request({ type: 'solid', webId: WEB_ID }), res, {});

    expect(JSON.parse(res.body).aiConnection).toEqual({ status: 'error', reason: 'service_access_missing' });
    expect(logger.warn).toHaveBeenCalledWith('Failed to read Pod AI Connection status: service_access_missing');
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('storage.example');
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('secret');
  });

  it('uses the resolved Pod URL as drizzle podUrl and AI container base in split deployments', async () => {
    const dbFactory = vi.fn(async () => ({
      init: vi.fn(async () => undefined),
      select: () => ({
        from: (resource: unknown) => ({
          where: () => ({ execute: async () => [] }),
          execute: async () => [],
        }),
      }),
    }));
    const hostedPodDataAccess = {
      getTrustedFetch: vi.fn(async () => (async () => new Response('', { status: 404 })) as typeof fetch),
    };
    const reader = new DrizzlePodAiConnectionStatusReader(hostedPodDataAccess, dbFactory);
    const auth = {
      type: 'solid' as const,
      webId: 'https://id.example/alice/profile/card#me',
      accessToken: 'solid-token',
    };

    const status = await reader.read({
      webId: 'https://id.example/alice/profile/card#me',
      podUrl: 'https://storage.example/alice/',
      auth,
    });

    expect(status).toMatchObject({
      status: 'available',
      containerUrl: 'https://storage.example/alice/settings/credentials.ttl',
    });
    expect(hostedPodDataAccess.getTrustedFetch).toHaveBeenCalledWith('https://id.example/alice/profile/card#me', auth);
    expect(dbFactory).toHaveBeenCalledWith(expect.objectContaining({
      webId: 'https://id.example/alice/profile/card#me',
      podUrl: 'https://storage.example/alice/',
    }));
  });
});
