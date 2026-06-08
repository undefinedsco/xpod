import type { ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import type { ApiServer } from '../../../src/api/ApiServer';
import type { AuthenticatedRequest } from '../../../src/api/middleware/AuthMiddleware';
import { registerRdfStatsRoutes } from '../../../src/api/handlers/RdfStatsHandler';

function createMockServer(): { server: ApiServer; routes: Record<string, Function> } {
  const routes: Record<string, Function> = {};
  const server = {
    get: vi.fn((path: string, handler: Function) => {
      routes[`GET ${path}`] = handler;
    }),
  } as unknown as ApiServer;
  return { server, routes };
}

function createRequest(auth?: AuthenticatedRequest['auth']): AuthenticatedRequest {
  return {
    auth,
    headers: {},
  } as unknown as AuthenticatedRequest;
}

function createResponse(): ServerResponse & { body: () => any } {
  const res = {
    statusCode: 0,
    setHeader: vi.fn(),
    end: vi.fn(),
    body() {
      const raw = (res.end as any).mock.calls[0]?.[0];
      return raw ? JSON.parse(raw) : undefined;
    },
  } as unknown as ServerResponse & { body: () => any };
  return res;
}

describe('RdfStatsHandler', () => {
  it('returns RDF storage stats for a Solid user', async () => {
    const snapshot = {
      available: true,
      engine: 'postgres-rdf',
      generatedAt: '2026-06-08T00:00:00.000Z',
      stats: {
        factsBytes: 100,
        derivedBytes: 40,
        totalBytes: 140,
        totalToFactsRatio: 1.4,
        derivedToFactsRatio: 0.4,
      },
    };
    const { server, routes } = createMockServer();
    const service = { snapshot: vi.fn().mockResolvedValue(snapshot) };
    registerRdfStatsRoutes(server, { rdfStorageStatsService: service as any });

    const response = createResponse();
    await routes['GET /v1/rdf/stats'](
      createRequest({
        type: 'solid',
        webId: 'https://id.example/alice/profile/card#me',
      }),
      response,
      {},
    );

    expect(response.statusCode).toBe(200);
    expect(response.body()).toEqual(snapshot);
    expect(service.snapshot).toHaveBeenCalledTimes(1);
  });

  it('requires usage:read for service callers', async () => {
    const { server, routes } = createMockServer();
    const service = { snapshot: vi.fn() };
    registerRdfStatsRoutes(server, { rdfStorageStatsService: service as any });

    const response = createResponse();
    await routes['GET /v1/rdf/stats'](
      createRequest({
        type: 'service',
        serviceType: 'business',
        serviceId: 'billing',
        scopes: ['quota:write'],
      }),
      response,
      {},
    );

    expect(response.statusCode).toBe(403);
    expect(response.body()).toEqual({ error: 'Missing required scope: usage:read' });
    expect(service.snapshot).not.toHaveBeenCalled();
  });

  it('returns unavailable snapshots without converting them to errors', async () => {
    const snapshot = {
      available: false,
      engine: 'unsupported',
      generatedAt: '2026-06-08T00:00:00.000Z',
      reason: 'not-cloud',
    };
    const { server, routes } = createMockServer();
    const service = { snapshot: vi.fn().mockResolvedValue(snapshot) };
    registerRdfStatsRoutes(server, { rdfStorageStatsService: service as any });

    const response = createResponse();
    await routes['GET /v1/rdf/stats'](
      createRequest({
        type: 'service',
        serviceType: 'cloud',
        serviceId: 'ops',
        scopes: ['usage:read'],
      }),
      response,
      {},
    );

    expect(response.statusCode).toBe(200);
    expect(response.body()).toEqual(snapshot);
  });
});
