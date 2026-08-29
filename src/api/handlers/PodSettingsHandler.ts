import type { ServerResponse } from 'node:http';
import { drizzle } from '@undefineds.co/drizzle-solid';
import {
  aiRuntimeRepository,
  credentialResource,
  type CredentialRow,
} from '@undefineds.co/models';
import { getLoggerFor } from 'global-logger-factory';
import type { ApiServer } from '../ApiServer';
import type { AuthenticatedRequest } from '../middleware/AuthMiddleware';
import type { PodLookupRepository, PodLookupResult } from '../../identity/drizzle/PodLookupRepository';
import type { UsageRepository, PodUsageRecord } from '../../storage/quota/UsageRepository';
import type { InternalPodAccessTokenProvider } from '../ai-gateway/pod/HostedPodDataAccess';

export interface PodSettingsStatus {
  identity: {
    webId: string;
    podUrl?: string;
  };
  storage: PodStorageStatus;
  aiConnection: PodAiConnectionsStatus;
  generatedAt: string;
}

export type PodStorageStatus =
  | {
    status: 'available';
    usage: {
      storageBytes: number;
      ingressBytes: number;
      egressBytes: number;
      computeSeconds: number;
      tokensUsed: number;
    };
    limits: {
      storageLimitBytes: number | null;
      bandwidthLimitBps: number | null;
      computeLimitSeconds: number | null;
      tokenLimitMonthly: number | null;
    };
    source: 'identity_usage';
  }
  | {
    status: 'unsupported' | 'error';
    reason: string;
  };

export type PodAiConnectionsStatus =
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

export interface PodAiConnectionsStatusReader {
  read(input: { webId: string; podUrl?: string }): Promise<PodAiConnectionsStatus>;
}

export interface PodSettingsHandlerOptions {
  podLookupRepository: Pick<PodLookupRepository, 'findByWebId'>;
  usageRepo: Pick<UsageRepository, 'getPodUsage'>;
  aiConnectionStatusReader?: PodAiConnectionsStatusReader;
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
        aiConnectionStatusReader.read({ webId, podUrl }).catch((error: unknown) => {
          const reason = safeAiConnectionsFailureReason(error);
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
      computeSeconds: usage.computeSeconds,
      tokensUsed: usage.tokensUsed,
    },
    limits: {
      storageLimitBytes: usage.storageLimitBytes ?? null,
      bandwidthLimitBps: usage.bandwidthLimitBps ?? null,
      computeLimitSeconds: usage.computeLimitSeconds ?? null,
      tokenLimitMonthly: usage.tokenLimitMonthly ?? null,
    },
    source: 'identity_usage',
  };
}

export class DrizzlePodAiConnectionsStatusReader implements PodAiConnectionsStatusReader {
  public constructor(
    private readonly internalPodAccess?: InternalPodAccessTokenProvider,
    private readonly deployment: string = 'local',
    private readonly dbFactory: (input: {
      webId: string;
      podUrl: string;
      fetch: typeof fetch;
    }) => Promise<AiConnectionsStatusDb> = createAiConnectionsStatusDb,
  ) {}

  public async read({ webId, podUrl }: { webId: string; podUrl?: string }): Promise<PodAiConnectionsStatus> {
    const trustedFetch = await this.internalPodAccess?.getTrustedFetch(webId);
    if (!trustedFetch) {
      return { status: 'unsupported', reason: 'not_configured' };
    }
    if (!podUrl) {
      return { status: 'unsupported', reason: 'pod_not_found' };
    }

    try {
      const db = await this.dbFactory({ webId, podUrl, fetch: trustedFetch });
      await db.init?.(credentialResource);

      const credentialRows: CredentialRow[] = [];
      for (const provider of KNOWN_AI_CONNECTION_PROVIDERS) {
        const id = aiRuntimeRepository.credentialId({ deployment: this.deployment, provider });
        const row = await db.findById<CredentialRow>(credentialResource, id);
        if (row && row.status === 'active') {
          credentialRows.push(row);
        }
      }
      const lastSyncAt = latestIso(credentialRows.map((row) => row.lastUsedAt ?? row.lastRefreshAt));

      return {
        status: 'available',
        containerUrl: new URL('settings/credentials.ttl', podUrl).toString(),
        configuredProviders: credentialRows.length,
        lastSyncAt,
        source: 'drizzle-solid',
      };
    } catch (error) {
      getLoggerFor('PodSettingsHandler').warn(`AI Connection status read failed for ${webId}: ${safeLogError(error)}`);
      return { status: 'error', reason: 'ai_connection_unavailable' };
    }
  }
}

const KNOWN_AI_CONNECTION_PROVIDERS = [
  'openai',
  'anthropic',
  'kimi',
  'bailian',
  'bailian-coding-plan',
  'bailian-token-plan',
  'deepseek',
] as const;

type AiConnectionsStatusDb = {
  init?: (...resources: unknown[]) => Promise<void>;
  findById<TRow>(resource: unknown, id: string): Promise<TRow | null>;
};

function createAiConnectionsStatusDb(input: {
  webId: string;
  podUrl: string;
  fetch: typeof fetch;
}): Promise<AiConnectionsStatusDb> {
  return Promise.resolve(drizzle({
    fetch: input.fetch,
    info: { webId: input.webId, isLoggedIn: true },
  } as any, {
    podUrl: input.podUrl,
    schema: {
      credential: credentialResource,
    },
  }) as unknown as AiConnectionsStatusDb);
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

function safeAiConnectionsFailureReason(error: unknown): string {
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
