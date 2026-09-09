import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { ApiServer } from '../../../src/api/ApiServer';
import type { AuthenticatedRequest } from '../../../src/api/middleware/AuthMiddleware';
import {
  registerAiConfigRoutes,
  type AiConfigLifecycleService,
  type AiConfigPolicy,
} from '../../../src/api/handlers/AiConfigHandler';

const WEB_ID = 'https://id.example/alice/profile/card#me';

function createServer(): { server: ApiServer; routes: Record<string, Function> } {
  const routes: Record<string, Function> = {};
  return {
    routes,
    server: {
      get: vi.fn((path: string, handler: Function) => { routes[`GET ${path}`] = handler; }),
      patch: vi.fn((path: string, handler: Function) => { routes[`PATCH ${path}`] = handler; }),
      post: vi.fn((path: string, handler: Function) => { routes[`POST ${path}`] = handler; }),
    } as unknown as ApiServer,
  };
}

function request(method: string, auth: AuthenticatedRequest['auth'], body?: unknown): AuthenticatedRequest {
  const req = new PassThrough() as PassThrough & AuthenticatedRequest;
  req.method = method;
  req.url = '/api/ai/config?podUrl=https%3A%2F%2Fevil.example%2F';
  req.headers = { 'content-type': 'application/json' };
  req.auth = auth;
  if (body !== undefined) req.write(JSON.stringify(body));
  req.end();
  return req;
}

function response(): any {
  return {
    statusCode: 0,
    headers: {} as Record<string, string>,
    setHeader(name: string, value: string) { this.headers[name.toLowerCase()] = value; },
    end: vi.fn(function(this: any, payload?: string) { this.body = payload; }),
  };
}

const policy: AiConfigPolicy = {
  schemaVersion: '1.0',
  models: {
    embeddingModel: '/settings/providers/openai.ttl#text-embedding-3-small',
  },
  documentProcessing: {
    ocrEnabled: true,
    automaticOcr: true,
    imageRecognition: true,
    pdfRecognition: true,
    tableRecognition: false,
    processingMode: 'auto',
    ocrFallbackOrder: ['ocr', 'reader', 'plain-text'],
    readerPolicy: 'auto',
    readerPriority: 'structure-first',
    maxFileSizeMb: 64,
    maxPages: 500,
    failureFallback: 'plain-text',
  },
  searchIndexing: {
    ftsEnabled: true,
    vectorEnabled: false,
    progressiveIndexingEnabled: true,
    textBackend: 'auto',
    vectorBackend: 'auto',
  },
  lifecycle: { automaticIndexing: true, refreshAfterSourceUpdate: true, removeAfterSourceDeletion: true },
};

describe('AiConfigHandler', () => {
  it('requires Solid authentication', async () => {
    const { server, routes } = createServer();
    registerAiConfigRoutes(server, {
      podLookupRepository: { findByWebId: vi.fn() },
      store: { read: vi.fn(), update: vi.fn() },
    });
    const res = response();

    await routes['GET /api/ai/config'](request('GET', undefined), res, {});

    expect(res.statusCode).toBe(401);
  });

  it('rejects AI gateway key principals for owner-scoped config reads and mutations', async () => {
    const { server, routes } = createServer();
    const podLookupRepository = { findByWebId: vi.fn() };
    const store = { read: vi.fn(), update: vi.fn() };
    const lifecycle: AiConfigLifecycleService = {
      status: vi.fn(),
      schedule: vi.fn(),
      supportedTargets: vi.fn(() => ['fts' as const]),
    };
    registerAiConfigRoutes(server, {
      podLookupRepository,
      store,
      lifecycle,
    });
    const gatewayPrincipal = {
      type: 'solid' as const,
      webId: WEB_ID,
      viaGatewayApiKey: true,
      gatewayKeyId: 'gk_test',
      scopes: ['ai:chat'],
    };

    const read = response();
    await routes['GET /api/ai/config'](request('GET', gatewayPrincipal), read);
    expect(read.statusCode).toBe(403);

    const update = response();
    await routes['PATCH /api/ai/config'](request('PATCH', gatewayPrincipal, {
      searchIndexing: { ftsEnabled: true },
    }), update);
    expect(update.statusCode).toBe(403);

    const rebuild = response();
    await routes['POST /api/ai/config/rebuild'](request('POST', {
      ...gatewayPrincipal,
      internalInvocation: true,
    }, { target: 'fts' }), rebuild);
    expect(rebuild.statusCode).toBe(403);

    expect(podLookupRepository.findByWebId).not.toHaveBeenCalled();
    expect(store.read).not.toHaveBeenCalled();
    expect(store.update).not.toHaveBeenCalled();
    expect(lifecycle.status).not.toHaveBeenCalled();
    expect(lifecycle.schedule).not.toHaveBeenCalled();
  });

  it('derives the Pod only from the authenticated WebID and reports runtime capabilities separately', async () => {
    const { server, routes } = createServer();
    const podLookupRepository = {
      findByWebId: vi.fn(async () => ({
        podId: 'pod-alice',
        accountId: 'account-alice',
        baseUrl: 'https://storage.example/alice/',
        storageUrl: 'https://storage.example/alice/',
        webId: WEB_ID,
      })),
    };
    const store = { read: vi.fn(async () => policy), update: vi.fn() };
    registerAiConfigRoutes(server, {
      podLookupRepository,
      store,
      capabilities: () => ({ textBackends: ['fts5'], vectorBackends: ['vec'], rebuildSupported: true }),
    });
    const res = response();

    await routes['GET /api/ai/config'](request('GET', { type: 'solid', webId: WEB_ID }), res, {});

    expect(podLookupRepository.findByWebId).toHaveBeenCalledWith(WEB_ID);
    expect(store.read).toHaveBeenCalledWith({
      webId: WEB_ID,
      podUrl: 'https://storage.example/alice/',
      auth: expect.objectContaining({ type: 'solid', webId: WEB_ID }),
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      config: policy,
      capabilities: { textBackends: ['fts5'], vectorBackends: ['vec'], rebuildSupported: false, rebuildTargets: [] },
      lifecycle: { pending: 0, recent: [] },
    });
    expect(res.body).not.toContain('evil.example');
  });

  it('validates updates before writing the authenticated Pod', async () => {
    const { server, routes } = createServer();
    const store = { read: vi.fn(), update: vi.fn(async () => policy) };
    registerAiConfigRoutes(server, {
      podLookupRepository: {
        findByWebId: vi.fn(async () => ({
          podId: 'pod-alice', accountId: 'account-alice', baseUrl: 'https://storage.example/alice/', webId: WEB_ID,
        })),
      },
      store,
    });

    const invalid = response();
    await routes['PATCH /api/ai/config'](request('PATCH', { type: 'solid', webId: WEB_ID }, {
      searchIndexing: { textBackend: 'elasticsearch' },
    }), invalid, {});
    expect(invalid.statusCode).toBe(400);
    expect(store.update).not.toHaveBeenCalled();

    const valid = response();
    await routes['PATCH /api/ai/config'](request('PATCH', { type: 'solid', webId: WEB_ID }, {
      models: { ocrModel: '/settings/providers/paddleocr.ttl#pp-ocrv6' },
      searchIndexing: { ftsEnabled: true, vectorEnabled: true, textBackend: 'auto', vectorBackend: 'auto' },
    }), valid, {});

    expect(valid.statusCode).toBe(200);
    expect(store.update).toHaveBeenCalledWith({
      webId: WEB_ID,
      podUrl: 'https://storage.example/alice/',
      auth: expect.objectContaining({ type: 'solid', webId: WEB_ID }),
      patch: {
        models: { ocrModel: '/settings/providers/paddleocr.ttl#pp-ocrv6' },
        searchIndexing: { ftsEnabled: true, vectorEnabled: true, textBackend: 'auto', vectorBackend: 'auto' },
      },
    });
  });

  it('accepts bounded document-reader and lifecycle policy without accepting unknown controls', async () => {
    const { server, routes } = createServer();
    const store = { read: vi.fn(), update: vi.fn(async () => policy) };
    registerAiConfigRoutes(server, {
      podLookupRepository: { findByWebId: vi.fn(async () => ({
        podId: 'pod-alice',
        accountId: 'account-alice',
        baseUrl: 'https://storage.example/alice/',
      })) },
      store,
    });

    const valid = response();
    await routes['PATCH /api/ai/config'](request('PATCH', { type: 'solid', webId: WEB_ID }, {
      documentProcessing: {
        imageRecognition: true,
        pdfRecognition: true,
        ocrFallbackOrder: ['ocr', 'reader'],
        readerPolicy: 'auto',
        readerPriority: 'structure-first',
        maxFileSizeMb: 64,
        maxPages: 500,
        failureFallback: 'plain-text',
      },
      lifecycle: {
        automaticIndexing: true,
        refreshAfterSourceUpdate: true,
        removeAfterSourceDeletion: true,
      },
    }), valid);

    expect(valid.statusCode).toBe(200);
    expect(store.update).toHaveBeenCalledWith(expect.objectContaining({ patch: {
      documentProcessing: expect.objectContaining({ maxFileSizeMb: 64, maxPages: 500 }),
      lifecycle: {
        automaticIndexing: true,
        refreshAfterSourceUpdate: true,
        removeAfterSourceDeletion: true,
      },
    } }));

    const invalid = response();
    await routes['PATCH /api/ai/config'](request('PATCH', { type: 'solid', webId: WEB_ID }, {
      documentProcessing: { maxPages: 100_000 },
    }), invalid);
    expect(invalid.statusCode).toBe(400);
  });

  it('reports lifecycle evidence and schedules only executor-supported rebuild targets', async () => {
    const { server, routes } = createServer();
    const lifecycle: AiConfigLifecycleService = {
      status: vi.fn(async () => ({
        configurationVersion: '2026-08-09T01:00:00.000Z',
        pending: 1,
        recent: [{ id: 'job-1', target: 'fts' as const, status: 'queued' as const, createdAt: '2026-08-09T01:00:00.000Z' }],
      })),
      schedule: vi.fn(async () => ({
        id: 'job-2',
        target: 'fts' as const,
        status: 'queued' as const,
        createdAt: '2026-08-09T02:00:00.000Z',
      })),
      supportedTargets: vi.fn(() => ['fts' as const]),
    };
    registerAiConfigRoutes(server, {
      podLookupRepository: { findByWebId: vi.fn(async () => ({
        podId: 'pod-alice',
        accountId: 'account-alice',
        baseUrl: 'https://storage.example/alice/',
      })) },
      store: { read: vi.fn(async () => policy), update: vi.fn() },
      lifecycle,
      capabilities: () => ({ textBackends: ['fts5'], vectorBackends: ['vec'], rebuildSupported: true }),
    });

    const read = response();
    await routes['GET /api/ai/config'](request('GET', { type: 'solid', webId: WEB_ID }), read);
    expect(JSON.parse(read.body).lifecycle).toMatchObject({ pending: 1, recent: [{ target: 'fts', status: 'queued' }] });
    expect(JSON.parse(read.body).capabilities.rebuildTargets).toEqual(['fts']);

    const schedule = response();
    await routes['POST /api/ai/config/rebuild'](request('POST', { type: 'solid', webId: WEB_ID }, { target: 'fts' }), schedule);
    expect(schedule.statusCode).toBe(202);
    expect(lifecycle.schedule).toHaveBeenCalledWith(expect.objectContaining({ webId: WEB_ID, target: 'fts' }));

    const unsupported = response();
    await routes['POST /api/ai/config/rebuild'](request('POST', { type: 'solid', webId: WEB_ID }, { target: 'vector' }), unsupported);
    expect(unsupported.statusCode).toBe(409);
  });
});
