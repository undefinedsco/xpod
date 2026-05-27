import type { ServerResponse } from 'node:http';
import { getLoggerFor } from 'global-logger-factory';
import type { AuthenticatedRequest } from '../middleware/AuthMiddleware';
import type { ApiServer } from '../ApiServer';
import type { UsageRepository } from '../../storage/quota/UsageRepository';
import { hasScope } from '../auth/AuthContext';

export interface UsageHandlerOptions {
  usageRepo: UsageRepository;
}

/**
 * Handler for usage query API
 *
 * Requires ServiceAuthContext with 'usage:read' scope.
 *
 * GET /v1/usage/accounts/:accountId - Get account usage details
 * GET /v1/usage/pods/:podId         - Get pod usage details
 */
export function registerUsageRoutes(server: ApiServer, options: UsageHandlerOptions): void {
  const logger = getLoggerFor('UsageHandler');
  const { usageRepo } = options;

  // GET /v1/usage/accounts/:accountId
  server.get('/v1/usage/accounts/:accountId', async (request, response, params) => {
    if (!requireUsageRead(request, response)) {
      return;
    }

    const accountId = decodeURIComponent(params.accountId);

    try {
      const usage = await usageRepo.getAccountUsage(accountId);
      if (!usage) {
        sendJson(response, 200, {
          accountId,
          usage: {
            storageBytes: 0,
            ingressBytes: 0,
            egressBytes: 0,
            computeSeconds: 0,
            tokensUsed: 0,
            periodStart: null,
          },
        });
        return;
      }

      sendJson(response, 200, {
        accountId,
        usage: {
          storageBytes: usage.storageBytes,
          ingressBytes: usage.ingressBytes,
          egressBytes: usage.egressBytes,
          computeSeconds: usage.computeSeconds,
          tokensUsed: usage.tokensUsed,
          periodStart: usage.periodStart ? new Date(usage.periodStart * 1000).toISOString() : null,
        },
        limits: {
          storageLimitBytes: usage.storageLimitBytes ?? null,
          bandwidthLimitBps: usage.bandwidthLimitBps ?? null,
          computeLimitSeconds: usage.computeLimitSeconds ?? null,
          tokenLimitMonthly: usage.tokenLimitMonthly ?? null,
        },
      });
    } catch (error) {
      logger.error(`Failed to get account usage: ${error}`);
      sendJson(response, 500, { error: 'Failed to get usage' });
    }
  });

  // GET /v1/usage/pods/:podId
  server.get('/v1/usage/pods/:podId', async (request, response, params) => {
    if (!requireUsageRead(request, response)) {
      return;
    }

    const podId = decodeURIComponent(params.podId);

    try {
      const usage = await usageRepo.getPodUsage(podId);
      if (!usage) {
        sendJson(response, 404, { error: 'Pod usage not found' });
        return;
      }

      sendJson(response, 200, {
        podId,
        accountId: usage.accountId,
        usage: {
          storageBytes: usage.storageBytes,
          ingressBytes: usage.ingressBytes,
          egressBytes: usage.egressBytes,
          computeSeconds: usage.computeSeconds,
          tokensUsed: usage.tokensUsed,
          periodStart: usage.periodStart ? new Date(usage.periodStart * 1000).toISOString() : null,
        },
        limits: {
          storageLimitBytes: usage.storageLimitBytes ?? null,
          bandwidthLimitBps: usage.bandwidthLimitBps ?? null,
          computeLimitSeconds: usage.computeLimitSeconds ?? null,
          tokenLimitMonthly: usage.tokenLimitMonthly ?? null,
        },
      });
    } catch (error) {
      logger.error(`Failed to get pod usage: ${error}`);
      sendJson(response, 500, { error: 'Failed to get usage' });
    }
  });
}

function requireUsageRead(request: AuthenticatedRequest, response: ServerResponse): boolean {
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
  // Allow Solid auth (for admin/user self-query)
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
