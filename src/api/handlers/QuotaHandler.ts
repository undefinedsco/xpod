import type { ServerResponse } from 'node:http';
import { getLoggerFor } from 'global-logger-factory';
import type { AuthenticatedRequest } from '../middleware/AuthMiddleware';
import type { ApiServer } from '../ApiServer';
import type { QuotaService } from '../../quota/QuotaService';
import type { AccountRepository } from '../../identity/drizzle/AccountRepository';

export interface QuotaHandlerOptions {
  quotaService: QuotaService;
  accountRepo: AccountRepository;
}

/**
 * Handler for quota management API
 * 
 * These endpoints are for internal billing system use.
 * They require authentication via client credentials.
 * 
 * GET    /v1/quota/accounts/:accountId - Get account quota
 * PUT    /v1/quota/accounts/:accountId - Set account quota
 * DELETE /v1/quota/accounts/:accountId - Clear account quota
 * GET    /v1/quota/pods/:podId - Get pod quota
 * PUT    /v1/quota/pods/:podId - Set pod quota
 * DELETE /v1/quota/pods/:podId - Clear pod quota
 */
export function registerQuotaRoutes(server: ApiServer, options: QuotaHandlerOptions): void {
  const logger = getLoggerFor('QuotaHandler');
  const { quotaService, accountRepo } = options;

  // GET /api/quota/accounts/:accountId
  server.get('/v1/quota/accounts/:accountId', async (request, response, params) => {
    const accountId = decodeURIComponent(params.accountId);

    try {
      const limit = await quotaService.getAccountLimit(accountId);
      sendJson(response, 200, {
        type: 'account',
        accountId,
        quotaLimit: limit ?? null,
      });
    } catch (error) {
      logger.error(`Failed to get account quota: ${error}`);
      sendJson(response, 500, { error: 'Failed to get quota' });
    }
  });

  // PUT /api/quota/accounts/:accountId
  server.put('/v1/quota/accounts/:accountId', async (request, response, params) => {
    const accountId = decodeURIComponent(params.accountId);
    const body = await readJsonBody(request);

    if (!body || typeof body !== 'object') {
      sendJson(response, 400, { error: 'Request body must be a JSON object' });
      return;
    }

    const payload = body as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(payload, 'quotaLimit')) {
      sendJson(response, 400, { error: 'Body must include quotaLimit' });
      return;
    }

    const quota = extractQuota(payload.quotaLimit);
    if (quota === undefined) {
      sendJson(response, 400, { error: 'quotaLimit must be a non-negative number or null' });
      return;
    }

    try {
      await quotaService.setAccountLimit(accountId, quota);
      const latest = await quotaService.getAccountLimit(accountId);
      
      logger.info(`Set account ${accountId} quota to ${quota}`);
      
      sendJson(response, 200, {
        status: 'updated',
        targetType: 'account',
        targetId: accountId,
        quotaLimit: latest ?? null,
      });
    } catch (error) {
      logger.error(`Failed to set account quota: ${error}`);
      sendJson(response, 500, { error: 'Failed to set quota' });
    }
  });

  // DELETE /api/quota/accounts/:accountId
  server.delete('/v1/quota/accounts/:accountId', async (request, response, params) => {
    const accountId = decodeURIComponent(params.accountId);

    try {
      await quotaService.setAccountLimit(accountId, null);
      
      logger.info(`Cleared account ${accountId} quota`);
      
      sendJson(response, 200, {
        status: 'cleared',
        targetType: 'account',
        targetId: accountId,
      });
    } catch (error) {
      logger.error(`Failed to clear account quota: ${error}`);
      sendJson(response, 500, { error: 'Failed to clear quota' });
    }
  });

  // GET /api/quota/pods/:podId
  server.get('/v1/quota/pods/:podId', async (request, response, params) => {
    const podId = decodeURIComponent(params.podId);

    try {
      const podInfo = await accountRepo.getPodInfo(podId);
      if (!podInfo) {
        sendJson(response, 404, { error: 'Pod not found' });
        return;
      }

      const limit = await quotaService.getPodLimit(podId);
      sendJson(response, 200, {
        type: 'pod',
        podId,
        accountId: podInfo.accountId,
        baseUrl: podInfo.baseUrl ?? null,
        quotaLimit: limit ?? null,
      });
    } catch (error) {
      logger.error(`Failed to get pod quota: ${error}`);
      sendJson(response, 500, { error: 'Failed to get quota' });
    }
  });

  // PUT /api/quota/pods/:podId
  server.put('/v1/quota/pods/:podId', async (request, response, params) => {
    const podId = decodeURIComponent(params.podId);
    const body = await readJsonBody(request);

    if (!body || typeof body !== 'object') {
      sendJson(response, 400, { error: 'Request body must be a JSON object' });
      return;
    }

    const payload = body as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(payload, 'quotaLimit')) {
      sendJson(response, 400, { error: 'Body must include quotaLimit' });
      return;
    }

    const quota = extractQuota(payload.quotaLimit);
    if (quota === undefined) {
      sendJson(response, 400, { error: 'quotaLimit must be a non-negative number or null' });
      return;
    }

    try {
      const podInfo = await accountRepo.getPodInfo(podId);
      if (!podInfo) {
        sendJson(response, 404, { error: 'Pod not found' });
        return;
      }

      await quotaService.setPodLimit(podId, quota);
      const latest = await quotaService.getPodLimit(podId);
      
      logger.info(`Set pod ${podId} quota to ${quota}`);
      
      sendJson(response, 200, {
        status: 'updated',
        targetType: 'pod',
        targetId: podId,
        quotaLimit: latest ?? null,
      });
    } catch (error) {
      logger.error(`Failed to set pod quota: ${error}`);
      sendJson(response, 500, { error: 'Failed to set quota' });
    }
  });

  // DELETE /api/quota/pods/:podId
  server.delete('/v1/quota/pods/:podId', async (request, response, params) => {
    const podId = decodeURIComponent(params.podId);

    try {
      const podInfo = await accountRepo.getPodInfo(podId);
      if (!podInfo) {
        sendJson(response, 404, { error: 'Pod not found' });
        return;
      }

      await quotaService.setPodLimit(podId, null);
      
      logger.info(`Cleared pod ${podId} quota`);
      
      sendJson(response, 200, {
        status: 'cleared',
        targetType: 'pod',
        targetId: podId,
      });
    } catch (error) {
      logger.error(`Failed to clear pod quota: ${error}`);
      sendJson(response, 500, { error: 'Failed to clear quota' });
    }
  });
}

function extractQuota(value: unknown): number | null | undefined {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return value;
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
