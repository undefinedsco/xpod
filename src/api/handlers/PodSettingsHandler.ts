import type { ServerResponse } from 'node:http';
import { getLoggerFor } from 'global-logger-factory';
import type { ApiServer } from '../ApiServer';
import type { AuthenticatedRequest } from '../middleware/AuthMiddleware';
import type { PodLookupRepository, PodLookupResult } from '../../identity/drizzle/PodLookupRepository';
import type { UsageRepository, PodUsageRecord } from '../../storage/quota/UsageRepository';

export interface PodSettingsStatus {
  identity: {
    webId: string;
    podUrl?: string;
  };
  storage: PodStorageStatus;
  generatedAt: string;
}

export type PodStorageStatus =
  | {
    status: 'available';
    usage: {
      storageBytes: number;
      ingressBytes: number;
      egressBytes: number;
    };
    limits: {
      storageLimitBytes: number | null;
      bandwidthLimitBps: number | null;
    };
    source: 'identity_usage';
  }
  | {
    status: 'unsupported' | 'error';
    reason: string;
  };

export interface PodSettingsHandlerOptions {
  podLookupRepository: Pick<PodLookupRepository, 'findByWebId'>;
  usageRepo: Pick<UsageRepository, 'getPodUsage'>;
  now?: () => Date;
  logger?: Pick<ReturnType<typeof getLoggerFor>, 'error'>;
}

export function registerPodSettingsRoutes(server: ApiServer, options: PodSettingsHandlerOptions): void {
  const logger = options.logger ?? getLoggerFor('PodSettingsHandler');
  const now = options.now ?? (() => new Date());

  server.get('/api/pod/settings/status', async (request, response) => {
    if (!request.auth || request.auth.type !== 'solid') {
      sendJson(response, 401, { error: 'Authentication required' });
      return;
    }

    const webId = request.auth.webId;
    try {
      const pod = await options.podLookupRepository.findByWebId(webId);
      const podUrl = pod?.storageUrl ?? pod?.baseUrl;
      const storage = await readStorageStatus(options.usageRepo, pod);

      sendJson(response, 200, {
        identity: {
          webId,
          podUrl,
        },
        storage,
        generatedAt: now().toISOString(),
      } satisfies PodSettingsStatus);
    } catch (error) {
      logger.error(`Failed to read Pod settings status: ${safeLogError(error)}`);
      sendJson(response, 500, { error: 'Failed to read Pod settings status' });
    }
  });
}

async function readStorageStatus(
  usageRepo: Pick<UsageRepository, 'getPodUsage'>,
  pod: PodLookupResult | undefined,
): Promise<PodStorageStatus> {
  if (!pod) {
    return { status: 'unsupported', reason: 'pod_not_found' };
  }

  let usage: PodUsageRecord | undefined;
  try {
    usage = await usageRepo.getPodUsage(pod.podId);
  } catch {
    return { status: 'error', reason: 'usage_unavailable' };
  }

  if (!usage) {
    return { status: 'unsupported', reason: 'usage_not_available' };
  }

  return {
    status: 'available',
    usage: {
      storageBytes: usage.storageBytes,
      ingressBytes: usage.ingressBytes,
      egressBytes: usage.egressBytes,
    },
    limits: {
      storageLimitBytes: usage.storageLimitBytes ?? null,
      bandwidthLimitBps: usage.bandwidthLimitBps ?? null,
    },
    source: 'identity_usage',
  };
}

function sendJson(response: ServerResponse, status: number, data: unknown): void {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(data));
}

function safeLogError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
