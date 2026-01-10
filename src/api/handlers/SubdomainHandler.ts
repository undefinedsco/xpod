import type { ServerResponse } from 'node:http';
import { getLoggerFor } from 'global-logger-factory';
import type { AuthenticatedRequest } from '../middleware/AuthMiddleware';
import type { ApiServer } from '../ApiServer';
import type { SubdomainService, SubdomainRegistration } from '../../subdomain/SubdomainService';
import { getWebId, isSolidAuth } from '../auth/AuthContext';

export interface SubdomainHandlerOptions {
  subdomainService: SubdomainService;
}

/**
 * Handler for subdomain management API
 *
 * GET  /v1/subdomain/check?name=xxx - Check subdomain availability (public)
 * GET  /v1/subdomain - List user's subdomain registrations
 * GET  /v1/subdomain/:name - Get subdomain info
 * POST /v1/subdomain/register - Register a new subdomain
 * DELETE /v1/subdomain/:name - Release a subdomain
 * POST /v1/subdomain/:name/start - Start tunnel
 * POST /v1/subdomain/:name/stop - Stop tunnel
 */
export function registerSubdomainRoutes(server: ApiServer, options: SubdomainHandlerOptions): void {
  const logger = getLoggerFor('SubdomainHandler');
  const service = options.subdomainService;

  const rejectApiKey = (request: AuthenticatedRequest, response: ServerResponse): boolean => {
    const auth = request.auth;
    if (auth && isSolidAuth(auth) && auth.viaApiKey) {
      sendJson(response, 403, { error: 'API key is not allowed for this endpoint' });
      return true;
    }
    return false;
  };

  // GET /v1/subdomain/check?name=xxx - Check availability (public)
  server.get('/v1/subdomain/check', async (request, response, _params) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    const name = url.searchParams.get('name');

    if (!name) {
      sendJson(response, 400, { error: 'Missing "name" query parameter' });
      return;
    }

    try {
      const result = await service.checkAvailability(name);
      sendJson(response, 200, {
        subdomain: name,
        available: result.available,
        reason: result.reason,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error(`Failed to check availability: ${error}`);
      sendJson(response, 500, { error: 'Failed to check availability' });
    }
  }, { public: true });

  // GET /v1/subdomain - List user's registrations
  server.get('/v1/subdomain', async (request, response, _params) => {
    if (rejectApiKey(request, response)) {
      return;
    }
    const auth = request.auth!;
    const webId = getWebId(auth);

    if (!webId) {
      sendJson(response, 400, { error: 'Cannot determine user' });
      return;
    }

    try {
      // Filter registrations by owner
      const allRegistrations = service.getAllRegistrations();
      const userRegistrations = allRegistrations.filter(r => r.ownerId === webId);

      sendJson(response, 200, {
        registrations: userRegistrations.map(formatRegistration),
        total: userRegistrations.length,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error(`Failed to list registrations: ${error}`);
      sendJson(response, 500, { error: 'Failed to list registrations' });
    }
  });

  // GET /v1/subdomain/:name - Get subdomain info
  server.get('/v1/subdomain/:name', async (request, response, params) => {
    if (rejectApiKey(request, response)) {
      return;
    }
    const auth = request.auth!;
    const webId = getWebId(auth);
    const name = decodeURIComponent(params.name);

    if (!webId) {
      sendJson(response, 400, { error: 'Cannot determine user' });
      return;
    }

    try {
      const registration = service.getRegistration(name);
      
      if (!registration) {
        sendJson(response, 404, { error: 'Subdomain not found' });
        return;
      }

      // Check ownership
      if (registration.ownerId !== webId) {
        sendJson(response, 403, { error: 'Access denied' });
        return;
      }

      sendJson(response, 200, {
        ...formatRegistration(registration),
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error(`Failed to get registration: ${error}`);
      sendJson(response, 500, { error: 'Failed to get registration' });
    }
  });

  // POST /v1/subdomain/register - Register a new subdomain
  server.post('/v1/subdomain/register', async (request, response, _params) => {
    if (rejectApiKey(request, response)) {
      return;
    }
    const auth = request.auth!;
    const webId = getWebId(auth);

    if (!webId) {
      sendJson(response, 400, { error: 'Cannot determine user' });
      return;
    }

    const body = await readJsonBody(request);
    if (!body || typeof body !== 'object') {
      sendJson(response, 400, { error: 'Invalid request body' });
      return;
    }

    const { subdomain, localPort, publicIp } = body as Record<string, unknown>;

    if (!subdomain || typeof subdomain !== 'string') {
      sendJson(response, 400, { error: 'Missing "subdomain" field' });
      return;
    }

    if (!localPort || typeof localPort !== 'number') {
      sendJson(response, 400, { error: 'Missing or invalid "localPort" field' });
      return;
    }

    try {
      const registration = await service.register({
        subdomain,
        localPort,
        publicIp: typeof publicIp === 'string' ? publicIp : undefined,
        ownerId: webId,
      });

      logger.info(`Registered subdomain: ${registration.fullDomain} for ${webId} (mode: ${registration.mode})`);

      sendJson(response, 201, {
        success: true,
        ...formatRegistration(registration),
        message: `Subdomain registered successfully in ${registration.mode} mode.`,
      });
    } catch (error) {
      logger.error(`Failed to register subdomain: ${error}`);
      if (error instanceof Error) {
        sendJson(response, 400, { error: error.message });
      } else {
        sendJson(response, 500, { error: 'Failed to register subdomain' });
      }
    }
  });

  // DELETE /v1/subdomain/:name - Release a subdomain
  server.delete('/v1/subdomain/:name', async (request, response, params) => {
    if (rejectApiKey(request, response)) {
      return;
    }
    const auth = request.auth!;
    const webId = getWebId(auth);
    const name = decodeURIComponent(params.name);

    if (!webId) {
      sendJson(response, 400, { error: 'Cannot determine user' });
      return;
    }

    try {
      const registration = service.getRegistration(name);
      
      if (!registration) {
        sendJson(response, 404, { error: 'Subdomain not found' });
        return;
      }

      // Check ownership
      if (registration.ownerId !== webId) {
        sendJson(response, 403, { error: 'Access denied' });
        return;
      }

      await service.release(name);

      logger.info(`Released subdomain: ${name} by ${webId}`);
      sendJson(response, 200, {
        success: true,
        subdomain: name,
        message: 'Subdomain released successfully.',
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error(`Failed to release subdomain: ${error}`);
      sendJson(response, 500, { error: 'Failed to release subdomain' });
    }
  });

  // POST /v1/subdomain/:name/start - Start tunnel
  server.post('/v1/subdomain/:name/start', async (request, response, params) => {
    if (rejectApiKey(request, response)) {
      return;
    }
    const auth = request.auth!;
    const webId = getWebId(auth);
    const name = decodeURIComponent(params.name);

    if (!webId) {
      sendJson(response, 400, { error: 'Cannot determine user' });
      return;
    }

    try {
      const registration = service.getRegistration(name);
      
      if (!registration) {
        sendJson(response, 404, { error: 'Subdomain not found' });
        return;
      }

      if (registration.ownerId !== webId) {
        sendJson(response, 403, { error: 'Access denied' });
        return;
      }

      await service.startTunnel(name);

      logger.info(`Started tunnel for subdomain: ${name}`);
      sendJson(response, 200, {
        success: true,
        subdomain: name,
        message: 'Tunnel started successfully.',
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error(`Failed to start tunnel: ${error}`);
      if (error instanceof Error) {
        sendJson(response, 400, { error: error.message });
      } else {
        sendJson(response, 500, { error: 'Failed to start tunnel' });
      }
    }
  });

  // POST /v1/subdomain/:name/stop - Stop tunnel
  server.post('/v1/subdomain/:name/stop', async (request, response, params) => {
    if (rejectApiKey(request, response)) {
      return;
    }
    const auth = request.auth!;
    const webId = getWebId(auth);
    const name = decodeURIComponent(params.name);

    if (!webId) {
      sendJson(response, 400, { error: 'Cannot determine user' });
      return;
    }

    try {
      const registration = service.getRegistration(name);
      
      if (!registration) {
        sendJson(response, 404, { error: 'Subdomain not found' });
        return;
      }

      if (registration.ownerId !== webId) {
        sendJson(response, 403, { error: 'Access denied' });
        return;
      }

      await service.stopTunnel();

      logger.info(`Stopped tunnel for subdomain: ${name}`);
      sendJson(response, 200, {
        success: true,
        subdomain: name,
        message: 'Tunnel stopped successfully.',
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error(`Failed to stop tunnel: ${error}`);
      sendJson(response, 500, { error: 'Failed to stop tunnel' });
    }
  });
}

function formatRegistration(reg: SubdomainRegistration): Record<string, unknown> {
  return {
    subdomain: reg.subdomain,
    fullDomain: reg.fullDomain,
    mode: reg.mode,
    publicIp: reg.publicIp,
    tunnelProvider: reg.tunnelConfig?.provider,
    tunnelEndpoint: reg.tunnelConfig?.endpoint,
    registeredAt: reg.registeredAt.toISOString(),
    ownerId: reg.ownerId,
  };
}

async function readJsonBody(request: AuthenticatedRequest): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      data += chunk;
    });
    request.on('end', () => {
      if (!data) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve(undefined);
      }
    });
    request.on('error', reject);
  });
}

function sendJson(response: ServerResponse, status: number, data: unknown): void {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(data));
}
