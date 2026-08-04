import type { ServerResponse } from 'node:http';
import { drizzle, eq } from '@undefineds.co/drizzle-solid';
import {
  credentialResource,
  type CredentialRow,
} from '@undefineds.co/models';
import { getLoggerFor } from 'global-logger-factory';
import type { ApiServer } from '../ApiServer';
import type { AuthenticatedRequest } from '../middleware/AuthMiddleware';
import type { PodLookupRepository, PodLookupResult } from '../../identity/drizzle/PodLookupRepository';
import type { UsageRepository, PodUsageRecord } from '../../storage/quota/UsageRepository';
import type { AuthContext } from '../auth/AuthContext';
import type { InternalPodAccessTokenProvider } from '../ai-gateway/pod/HostedPodDataAccess';

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

export class DrizzlePodAiConnectionStatusReader implements PodAiConnectionStatusReader {
  public constructor(
    private readonly internalPodAccess?: InternalPodAccessTokenProvider,
    private readonly dbFactory: (input: {
      webId: string;
      podUrl: string;
      fetch: typeof fetch;
    }) => Promise<AiConnectionStatusDb> = createAiConnectionStatusDb,
  ) {}

  public async read({ webId, podUrl, auth }: { webId: string; podUrl?: string; auth?: AuthContext }): Promise<PodAiConnectionStatus> {
    const trustedFetch = await this.internalPodAccess?.getTrustedFetch(webId, auth);
    if (!trustedFetch) {
      return { status: 'unsupported', reason: 'not_configured' };
    }
    if (!podUrl) {
      return { status: 'unsupported', reason: 'pod_not_found' };
    }

    try {
      const db = await this.dbFactory({ webId, podUrl, fetch: trustedFetch });
      await db.init?.(credentialResource);

      const credentialRows = await db.select().from(credentialResource).where(eq(credentialResource.status, 'active')).execute() as CredentialRow[];
      const lastSyncAt = latestIso(credentialRows.map((row) => row.lastUsedAt ?? row.lastRefreshAt));

      return {
        status: 'available',
        containerUrl: new URL('settings/credentials.ttl', podUrl).toString(),
        configuredProviders: credentialRows.length,
        lastSyncAt,
        source: 'drizzle-solid',
      };
    } catch {
      return { status: 'error', reason: 'ai_connection_unavailable' };
    }
  }
}

type AiConnectionStatusDb = {
  init?: (...resources: unknown[]) => Promise<void>;
  select(): {
    from(resource: unknown): {
      where(condition: unknown): { execute(): Promise<unknown[]> };
      execute(): Promise<unknown[]>;
    };
  };
};

function createAiConnectionStatusDb(input: {
  webId: string;
  podUrl: string;
  fetch: typeof fetch;
}): Promise<AiConnectionStatusDb> {
  return Promise.resolve(drizzle({
    fetch: input.fetch,
    info: { webId: input.webId, isLoggedIn: true },
  } as any, {
    podUrl: input.podUrl,
    schema: {
      credential: credentialResource,
    },
  }) as unknown as AiConnectionStatusDb);
}

function latestIso(values: unknown[]): string | undefined {
  const timestamps = values
    .map((value) => {
      if (value instanceof Date) return value.getTime();
      if (typeof value === 'string' || typeof value === 'number') {
        const parsed = Date.parse(String(value));
        return Number.isFinite(parsed) ? parsed : undefined;
      }
      return undefined;
    })
    .filter((value): value is number => value !== undefined);
  if (timestamps.length === 0) {
    return undefined;
  }
  return new Date(Math.max(...timestamps)).toISOString();
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
