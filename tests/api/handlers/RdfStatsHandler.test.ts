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

function createRequest(auth?: AuthenticatedRequest['auth'], url = '/v1/rdf/stats'): AuthenticatedRequest {
  return {
    auth,
    url,
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
        rdf3x: {
          factsDataVersion: 4,
          rdf3xFactsDataVersion: 3,
          refreshLag: 1,
          syncedWithFacts: false,
          stats: {
            membershipCount: 10,
            uniqueTripleCount: 10,
            graphCount: 2,
            pairProjectionRows: 20,
            termProjectionRows: 30,
            databaseBytes: 40,
            tableBytes: 30,
            indexBytes: 10,
            factsDataVersion: 3,
            spaceObjects: [],
          },
        },
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

  it('passes cache scope filters to the stats service', async () => {
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
      createRequest(
        {
          type: 'service',
          serviceType: 'cloud',
          serviceId: 'ops',
          scopes: ['usage:read'],
        },
        '/v1/rdf/stats?cacheScopeQuery=alice&cacheScopePrincipal=https%3A%2F%2Fid.example%2Falice%23me&cacheScopeLimit=25',
      ),
      response,
      {},
    );

    expect(response.statusCode).toBe(200);
    expect(service.snapshot).toHaveBeenCalledWith({
      cacheScope: {
        query: 'alice',
        principal: 'https://id.example/alice#me',
        limit: 25,
      },
    });
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

  it('exposes a public admin snapshot for the dashboard without changing the versioned API auth', async () => {
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
        slowQueries: {
          entryCount: 0,
          maxEntries: 20,
          entries: [],
        },
      },
    };
    const { server, routes } = createMockServer();
    const service = { snapshot: vi.fn().mockResolvedValue(snapshot) };
    registerRdfStatsRoutes(server, { rdfStorageStatsService: service as any });

    const response = createResponse();
    await routes['GET /api/admin/rdf/stats'](createRequest(), response, {});

    expect(response.statusCode).toBe(200);
    expect(response.body()).toEqual(snapshot);
    expect(service.snapshot).toHaveBeenCalledTimes(1);
  });
});
