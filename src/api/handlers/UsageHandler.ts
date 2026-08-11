import type { ServerResponse } from 'node:http';
import { getLoggerFor } from 'global-logger-factory';
import type { AuthenticatedRequest } from '../middleware/AuthMiddleware';
import type { ApiServer } from '../ApiServer';
import type { UsageRepository } from '../../storage/quota/UsageRepository';
import type { PodLookupRepository } from '../../identity/drizzle/PodLookupRepository';
import { hasScope } from '../auth/AuthContext';

export interface UsageOwnershipResolver {
  ownsAccount(input: { webId: string; accountId: string }): Promise<boolean>;
  ownsPod(input: { webId: string; podId: string }): Promise<boolean>;
}

export interface UsageHandlerOptions {
  usageRepo: UsageRepository;
  /** Explicit Solid ownership proof. Solid requests fail closed when absent. */
  ownershipResolver?: UsageOwnershipResolver;
}

/**
 * Adapt the canonical identity Pod lookup to the usage authorization boundary.
 *
 * A WebID is only considered to own an account or Pod when the identity store
 * returns an explicit linked record. No URL or identifier shape is inferred.
 */
export function createPodLookupUsageOwnershipResolver(
  podLookupRepository: Pick<PodLookupRepository, 'findAllByWebId'>,
): UsageOwnershipResolver {
  return {
    async ownsAccount({ webId, accountId }) {
      const pods = await podLookupRepository.findAllByWebId(webId);
      return pods.some((pod) => pod.accountId === accountId);
    },
    async ownsPod({ webId, podId }) {
      const pods = await podLookupRepository.findAllByWebId(webId);
      return pods.some((pod) => pod.podId === podId);
    },
  };
}

/**
 * Handler for usage query API
 *
 * Requires ServiceAuthContext with 'usage:read' scope, Solid auth, or a CSS
 * account token scoped to the requested account.
 *
 * GET /v1/usage/accounts/:accountId - Get account usage details
 * GET /v1/usage/pods/:podId         - Get pod usage details
 */
export function registerUsageRoutes(server: ApiServer, options: UsageHandlerOptions): void {
  const logger = getLoggerFor('UsageHandler');
  const { usageRepo } = options;

  // GET /v1/usage/accounts/:accountId
  server.get('/v1/usage/accounts/:accountId', async (request, response, params) => {
    const accountId = decodeURIComponent(params.accountId);
    if (!(await requireUsageRead(request, response, { kind: 'account', id: accountId }, options.ownershipResolver))) {
      return;
    }

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
    const podId = decodeURIComponent(params.podId);
    if (!(await requireUsageRead(request, response, { kind: 'pod', id: podId }, options.ownershipResolver))) {
      return;
    }

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

async function requireUsageRead(
  request: AuthenticatedRequest,
  response: ServerResponse,
  resource: { kind: 'account' | 'pod'; id: string },
  ownershipResolver?: UsageOwnershipResolver,
): Promise<boolean> {
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
  if (request.auth.type === 'account') {
    if (resource.kind === 'account' && request.auth.accountId === resource.id) {
      return true;
    }
    sendJson(response, 403, { error: 'Account token cannot access this usage resource' });
    return false;
  }
  if (request.auth.type === 'solid') {
    if (!ownershipResolver) {
      sendJson(response, 403, { error: 'Solid usage ownership cannot be verified' });
      return false;
    }
    try {
      const owned = resource.kind === 'account'
        ? await ownershipResolver.ownsAccount({ webId: request.auth.webId, accountId: resource.id })
        : await ownershipResolver.ownsPod({ webId: request.auth.webId, podId: resource.id });
      if (owned) {
        return true;
      }
    } catch {
      // Ownership failures are intentionally indistinguishable from a denied
      // lookup so a broken identity backend cannot widen access.
    }
    sendJson(response, 403, { error: 'Solid usage ownership cannot be verified' });
    return false;
  }
  sendJson(response, 403, { error: 'Insufficient permissions' });
  return false;
}

function sendJson(response: ServerResponse, status: number, data: unknown): void {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(data));
}
