import type { ServerResponse } from 'node:http';
import { getLoggerFor } from 'global-logger-factory';
import type { ApiServer } from '../ApiServer';
import type { AuthenticatedRequest } from '../middleware/AuthMiddleware';
import type { PodLookupRepository, PodLookupResult } from '../../identity/drizzle/PodLookupRepository';
import type { UsageRepository, PodUsageRecord } from '../../storage/quota/UsageRepository';
import type { AuthContext } from '../auth/AuthContext';
import type { GatewayDeployment } from '../ai-gateway/auth/InvocationTokenCodec';
import type { ProviderConnectionSummary } from '../ai-gateway/connect';

export interface PodSettingsStatus {
  identity: {
    webId: string;
    podUrl?: string;
  };
  storage: PodStorageStatus;
  aiConnection: PodAiConnectionStatus;
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

export type PodAiConnectionStatus =
  | {
    status: 'available';
    containerUrl?: string;
    configuredProviders: number;
    lastSyncAt?: string;
    source: 'drizzle-solid';
  }
  | {
    status: 'unsupported' | 'error';
    reason: string;
  };

export interface PodAiConnectionStatusReader {
  read(input: { webId: string; podUrl?: string; auth?: AuthContext }): Promise<PodAiConnectionStatus>;
}

export interface PodSettingsHandlerOptions {
  podLookupRepository: Pick<PodLookupRepository, 'findByWebId'>;
  usageRepo: Pick<UsageRepository, 'getPodUsage'>;
  aiConnectionStatusReader?: PodAiConnectionStatusReader;
  now?: () => Date;
  logger?: Pick<ReturnType<typeof getLoggerFor>, 'warn' | 'error'>;
}

export function registerPodSettingsRoutes(server: ApiServer, options: PodSettingsHandlerOptions): void {
  const logger = options.logger ?? getLoggerFor('PodSettingsHandler');
  const now = options.now ?? (() => new Date());
  const aiConnectionStatusReader = options.aiConnectionStatusReader ?? {
    read: async () => ({ status: 'unsupported', reason: 'not_configured' }) as const,
  };

  server.get('/api/pod/settings/status', async (request, response) => {
    if (!request.auth || request.auth.type !== 'solid') {
      sendJson(response, 401, { error: 'Authentication required' });
      return;
    }

    const webId = request.auth.webId;
    try {
      const pod = await options.podLookupRepository.findByWebId(webId);
      const podUrl = pod?.storageUrl ?? pod?.baseUrl;
      const [storage, aiConnection] = await Promise.all([
        readStorageStatus(options.usageRepo, pod),
        aiConnectionStatusReader.read({ webId, podUrl, auth: request.auth }).catch((error: unknown) => {
          const reason = safeAiConnectionFailureReason(error);
          logger.warn(`Failed to read Pod AI Connection status: ${reason}`);
          return { status: 'error', reason } as const;
        }),
      ]);

      sendJson(response, 200, {
        identity: {
          webId,
          podUrl,
        },
        storage,
        aiConnection,
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

type ProviderConnectStatusSource = {
  listProviders(input: {
    webId: string;
    deployment: GatewayDeployment;
    auth?: AuthContext;
  }): Promise<ProviderConnectionSummary[]>;
};

export class ProviderConnectPodAiConnectionStatusReader implements PodAiConnectionStatusReader {
  public constructor(
    private readonly connectService: ProviderConnectStatusSource,
    private readonly deployment: GatewayDeployment,
  ) {}

  public async read({ webId, podUrl, auth }: { webId: string; podUrl?: string; auth?: AuthContext }): Promise<PodAiConnectionStatus> {
    if (!podUrl) {
      return { status: 'unsupported', reason: 'pod_not_found' };
    }

    try {
      const providers = await this.connectService.listProviders({
        webId,
        deployment: this.deployment,
        auth,
      });

      return {
        status: 'available',
        containerUrl: new URL('settings/credentials.ttl', podUrl).toString(),
        configuredProviders: providers.filter((provider) => provider.status !== 'disconnected').length,
        source: 'drizzle-solid',
      };
    } catch {
      return { status: 'error', reason: 'ai_connection_unavailable' };
    }
  }
}

function sendJson(response: ServerResponse, status: number, data: unknown): void {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(data));
}

function safeLogError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeAiConnectionFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  for (const reason of [
    'service_access_missing',
    'not_configured',
    'pod_not_found',
    'ai_connection_unavailable',
  ]) {
    if (message.includes(reason)) {
      return reason;
    }
  }
  return 'ai_connection_unavailable';
}
