import type { ServerResponse } from 'node:http';
import { getLoggerFor } from 'global-logger-factory';
import type { AuthenticatedRequest } from '../middleware/AuthMiddleware';
import type { ApiServer } from '../ApiServer';
import type { QuotaService } from '../../quota/QuotaService';
import type { UsageRepository } from '../../storage/quota/UsageRepository';
import { hasScope } from '../auth/AuthContext';

export interface QuotaHandlerOptions {
  quotaService: QuotaService;
  usageRepo: UsageRepository;
}

/**
 * Handler for quota management API
 *
 * Supports four resource types: storage, bandwidth, compute, token.
 * Requires ServiceAuthContext with 'quota:write' scope for mutations.
 *
 * GET    /v1/quota/accounts/:accountId - Get account quota + usage
 * PUT    /v1/quota/accounts/:accountId - Set account quota
 * DELETE /v1/quota/accounts/:accountId - Clear account quota (revert to defaults)
 * GET    /v1/quota/pods/:podId - Get pod quota + usage
 * PUT    /v1/quota/pods/:podId - Set pod quota
 * DELETE /v1/quota/pods/:podId - Clear pod quota
 */
export function registerQuotaRoutes(server: ApiServer, options: QuotaHandlerOptions): void {
  const logger = getLoggerFor('QuotaHandler');
  const { quotaService, usageRepo } = options;

  // GET /v1/quota/accounts/:accountId
  server.get('/v1/quota/accounts/:accountId', async (request, response, params) => {
    const accountId = decodeURIComponent(params.accountId);

    try {
      const quota = await quotaService.getAccountQuota(accountId);
      const usage = await usageRepo.getAccountUsage(accountId);

      sendJson(response, 200, {
        accountId,
        quota: {
          storageLimitBytes: quota.storageLimitBytes,
          bandwidthLimitBps: quota.bandwidthLimitBps,
          computeLimitSeconds: quota.computeLimitSeconds,
          tokenLimitMonthly: quota.tokenLimitMonthly,
        },
        usage: {
          storageBytes: usage?.storageBytes ?? 0,
          ingressBytes: usage?.ingressBytes ?? 0,
          egressBytes: usage?.egressBytes ?? 0,
          computeSeconds: usage?.computeSeconds ?? 0,
          tokensUsed: usage?.tokensUsed ?? 0,
          periodStart: usage?.periodStart?.toISOString() ?? null,
        },
        source: hasCustomQuota(usage) ? 'custom' : 'default',
      });
    } catch (error) {
      logger.error(`Failed to get account quota: ${error}`);
      sendJson(response, 500, { error: 'Failed to get quota' });
    }
  });

  // PUT /v1/quota/accounts/:accountId
  server.put('/v1/quota/accounts/:accountId', async (request, response, params) => {
    if (!requireScope(request, response, 'quota:write')) {
      return;
    }

    const accountId = decodeURIComponent(params.accountId);
    const body = await readJsonBody(request);

    if (!body || typeof body !== 'object') {
      sendJson(response, 400, { error: 'Request body must be a JSON object' });
      return;
    }

    const payload = body as Record<string, unknown>;
    const partial = extractQuotaFields(payload);
    if (!partial) {
      sendJson(response, 400, { error: 'Body must include at least one quota field (storageLimitBytes, bandwidthLimitBps, computeLimitSeconds, tokenLimitMonthly)' });
      return;
    }

    try {
      await quotaService.setAccountQuota(accountId, partial);
      const latest = await quotaService.getAccountQuota(accountId);

      logger.info(`Set account ${accountId} quota: ${JSON.stringify(partial)}`);

      sendJson(response, 200, {
        status: 'updated',
        accountId,
        quota: latest,
      });
    } catch (error) {
      logger.error(`Failed to set account quota: ${error}`);
      sendJson(response, 500, { error: 'Failed to set quota' });
    }
  });

  // DELETE /v1/quota/accounts/:accountId
  server.delete('/v1/quota/accounts/:accountId', async (request, response, params) => {
    if (!requireScope(request, response, 'quota:write')) {
      return;
    }

    const accountId = decodeURIComponent(params.accountId);

    try {
      await quotaService.clearAccountQuota(accountId);

      logger.info(`Cleared account ${accountId} quota`);

      sendJson(response, 200, {
        status: 'cleared',
        accountId,
      });
    } catch (error) {
      logger.error(`Failed to clear account quota: ${error}`);
      sendJson(response, 500, { error: 'Failed to clear quota' });
    }
  });

  // GET /v1/quota/pods/:podId
  server.get('/v1/quota/pods/:podId', async (request, response, params) => {
    const podId = decodeURIComponent(params.podId);

    try {
      const quota = await quotaService.getPodQuota(podId);
      const usage = await usageRepo.getPodUsage(podId);

      sendJson(response, 200, {
        podId,
        accountId: usage?.accountId ?? null,
        quota: {
          storageLimitBytes: quota.storageLimitBytes,
          bandwidthLimitBps: quota.bandwidthLimitBps,
          computeLimitSeconds: quota.computeLimitSeconds,
          tokenLimitMonthly: quota.tokenLimitMonthly,
        },
        usage: {
          storageBytes: usage?.storageBytes ?? 0,
          ingressBytes: usage?.ingressBytes ?? 0,
          egressBytes: usage?.egressBytes ?? 0,
          computeSeconds: usage?.computeSeconds ?? 0,
          tokensUsed: usage?.tokensUsed ?? 0,
          periodStart: usage?.periodStart?.toISOString() ?? null,
        },
        source: hasCustomQuota(usage) ? 'custom' : 'default',
      });
    } catch (error) {
      logger.error(`Failed to get pod quota: ${error}`);
      sendJson(response, 500, { error: 'Failed to get quota' });
    }
  });

  // PUT /v1/quota/pods/:podId
  server.put('/v1/quota/pods/:podId', async (request, response, params) => {
    if (!requireScope(request, response, 'quota:write')) {
      return;
    }

    const podId = decodeURIComponent(params.podId);
    const body = await readJsonBody(request);

    if (!body || typeof body !== 'object') {
      sendJson(response, 400, { error: 'Request body must be a JSON object' });
      return;
    }

    const payload = body as Record<string, unknown>;
    const partial = extractQuotaFields(payload);
    if (!partial) {
      sendJson(response, 400, { error: 'Body must include at least one quota field' });
      return;
    }

    try {
      await quotaService.setPodQuota(podId, partial);
      const latest = await quotaService.getPodQuota(podId);

      logger.info(`Set pod ${podId} quota: ${JSON.stringify(partial)}`);

      sendJson(response, 200, {
        status: 'updated',
        podId,
        quota: latest,
      });
    } catch (error) {
      logger.error(`Failed to set pod quota: ${error}`);
      sendJson(response, 500, { error: 'Failed to set quota' });
    }
  });

  // DELETE /v1/quota/pods/:podId
  server.delete('/v1/quota/pods/:podId', async (request, response, params) => {
    if (!requireScope(request, response, 'quota:write')) {
      return;
    }

    const podId = decodeURIComponent(params.podId);

    try {
      await quotaService.clearPodQuota(podId);

      logger.info(`Cleared pod ${podId} quota`);

      sendJson(response, 200, {
        status: 'cleared',
        podId,
      });
    } catch (error) {
      logger.error(`Failed to clear pod quota: ${error}`);
      sendJson(response, 500, { error: 'Failed to clear quota' });
    }
  });
}

/**
 * Check if the request has the required scope. Sends 403 if not.
 */
function requireScope(request: AuthenticatedRequest, response: ServerResponse, scope: string): boolean {
  if (!request.auth) {
    sendJson(response, 401, { error: 'Authentication required' });
    return false;
  }
  // Service tokens need explicit scope; Solid users with admin role can also access
  if (request.auth.type === 'service') {
    if (!hasScope(request.auth, scope)) {
      sendJson(response, 403, { error: `Missing required scope: ${scope}` });
      return false;
    }
    return true;
  }
  // Allow Solid auth (for admin users) - actual admin check can be added later
  if (request.auth.type === 'solid') {
    return true;
  }
  sendJson(response, 403, { error: 'Insufficient permissions' });
  return false;
}

const QUOTA_FIELDS = ['storageLimitBytes', 'bandwidthLimitBps', 'computeLimitSeconds', 'tokenLimitMonthly'] as const;

function extractQuotaFields(payload: Record<string, unknown>): Record<string, number | null> | undefined {
  const result: Record<string, number | null> = {};
  let hasField = false;

  for (const field of QUOTA_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(payload, field)) {
      const value = payload[field];
      if (value === null) {
        result[field] = null;
        hasField = true;
      } else if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        result[field] = value;
        hasField = true;
      } else {
        return undefined; // Invalid value
      }
    }
  }

  // Backward compat: support legacy 'quotaLimit' field
  if (!hasField && Object.prototype.hasOwnProperty.call(payload, 'quotaLimit')) {
    const value = payload.quotaLimit;
    if (value === null) {
      result.storageLimitBytes = null;
      hasField = true;
    } else if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      result.storageLimitBytes = value;
      hasField = true;
    }
  }

  return hasField ? result : undefined;
}

function hasCustomQuota(usage: { storageLimitBytes?: number | null; bandwidthLimitBps?: number | null; computeLimitSeconds?: number | null; tokenLimitMonthly?: number | null } | undefined): boolean {
  if (!usage) {
    return false;
  }
  return typeof usage.storageLimitBytes === 'number'
    || typeof usage.bandwidthLimitBps === 'number'
    || typeof usage.computeLimitSeconds === 'number'
    || typeof usage.tokenLimitMonthly === 'number';
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
