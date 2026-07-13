import type { ServerResponse } from 'node:http';
import { getLoggerFor } from 'global-logger-factory';
import type { ApiServer } from '../ApiServer';
import { hasScope } from '../auth/AuthContext';
import type { AuthenticatedRequest } from '../middleware/AuthMiddleware';
import type { RdfStorageStatsService } from '../service/RdfStorageStatsService';
import type { RdfStorageStatsOptions } from '../../storage/rdf';

export interface RdfStatsHandlerOptions {
  rdfStorageStatsService: Pick<RdfStorageStatsService, 'snapshot'>;
}

export function registerRdfStatsRoutes(server: ApiServer, options: RdfStatsHandlerOptions): void {
  const logger = getLoggerFor('RdfStatsHandler');
  const { rdfStorageStatsService } = options;

  server.get('/v1/rdf/stats', async (request, response) => {
    if (!requireRdfStatsRead(request, response)) {
      return;
    }

    try {
      sendJson(response, 200, await rdfStorageStatsService.snapshot(parseRdfStatsOptions(request)));
    } catch (error) {
      logger.error(`Failed to get RDF storage stats: ${error}`);
      sendJson(response, 500, { error: 'Failed to get RDF storage stats' });
    }
  });

  server.get('/api/admin/rdf/stats', async (request, response) => {
    try {
      sendJson(response, 200, await rdfStorageStatsService.snapshot(parseRdfStatsOptions(request)));
    } catch (error) {
      logger.error(`Failed to get RDF storage stats: ${error}`);
      sendJson(response, 500, { error: 'Failed to get RDF storage stats' });
    }
  }, { public: true });
}

function parseRdfStatsOptions(request: AuthenticatedRequest): RdfStorageStatsOptions {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  const cacheScope: NonNullable<RdfStorageStatsOptions['cacheScope']> = {};
  assignIfDefined(cacheScope, 'query', optionalSearchParam(url, 'cacheScopeQuery'));
  assignIfDefined(cacheScope, 'principal', optionalSearchParam(url, 'cacheScopePrincipal'));
  assignIfDefined(cacheScope, 'basePath', optionalSearchParam(url, 'cacheScopeBasePath'));
  assignIfDefined(cacheScope, 'mode', optionalSearchParam(url, 'cacheScopeMode'));
  assignIfDefined(cacheScope, 'authorizationModel', optionalSearchParam(url, 'cacheScopeAuthorizationModel'));
  assignIfDefined(cacheScope, 'permissionVersion', optionalSearchParam(url, 'cacheScopePermissionVersion'));
  assignIfDefined(cacheScope, 'limit', optionalIntegerSearchParam(url, 'cacheScopeLimit'));
  if (Object.keys(cacheScope).length === 0) {
    return {};
  }
  return { cacheScope };
}

function assignIfDefined<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
  if (value !== undefined) {
    target[key] = value;
  }
}

function optionalSearchParam(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name)?.trim();
  return value ? value : undefined;
}

function optionalIntegerSearchParam(url: URL, name: string): number | undefined {
  const raw = url.searchParams.get(name);
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.floor(parsed) : undefined;
}

function requireRdfStatsRead(request: AuthenticatedRequest, response: ServerResponse): boolean {
  if (!request.auth) {
    sendJson(response, 401, { error: 'Authentication required' });
    return false;
  }
  if (request.auth.type === 'service') {
    if (!hasScope(request.auth, 'usage:read')) {
      sendJson(response, 403, { error: 'Missing required scope: usage:read' });
      return false;
    }
    return true;
  }
  if (request.auth.type === 'solid') {
    return true;
  }
  sendJson(response, 403, { error: 'Insufficient permissions' });
  return false;
}

function sendJson(response: ServerResponse, status: number, data: unknown): void {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(data));
}
