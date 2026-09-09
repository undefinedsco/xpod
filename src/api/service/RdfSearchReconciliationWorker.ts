import { createHash, randomUUID } from 'node:crypto';
import type { RdfEngineLike, RdfTextSourceMetadata } from '../../storage/rdf';
import type { StoreContext } from '../chatkit/store';
import { hasSolidClientCredentialsAuthority, type AuthContext } from '../auth/AuthContext';
import type { RunAuthContextRegistry } from '../runs/RunAuthContextRegistry';
import {
  normalizeRdfVectorModelVersion,
  type RdfSearchIndexingService,
  type RdfVectorIndexingResult,
} from './RdfSearchIndexingService';
import type {
  RdfSearchDesiredProfile,
  RdfSearchReconciliationRepository,
  RdfSearchReconciliationRow,
} from '../../search/RdfSearchReconciliationRepository';

export interface RdfSearchReconciliationWorkerOptions {
  repository: RdfSearchReconciliationRepository;
  indexingService?: RdfSearchIndexingService;
  contextRegistry: RunAuthContextRegistry;
  store?: {
    getAiConfig(context: StoreContext): Promise<RdfSearchEmbeddingConfig | undefined> | RdfSearchEmbeddingConfig | undefined;
  };
  rdfEngine?: Pick<RdfEngineLike, 'listTextSources'>;
  workerId?: string;
  now?: () => number;
  leaseDurationMs?: number;
  maxBatchSize?: number;
  intervalMs?: number;
  reconcileIntervalMs?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  sourcePageSize?: number;
  onError?: (error: unknown, input: RdfSearchReconciliationWorkerErrorInput) => void;
}

export interface RdfSearchEmbeddingConfig {
  providerId: string;
  baseUrl: string;
  proxyUrl?: string;
  defaultModel?: string;
  embeddingModel?: string;
  embeddingModelVersion?: string;
  apiKey: string;
  credentialId: string;
}

export interface RdfSearchReconciliationDrainResult {
  processed: number;
}

export interface RdfSearchRememberedContextReconciliationResult {
  contexts: number;
  sources: number;
}

export interface RdfSearchReconciliationWorkerErrorInput {
  phase: 'tick' | 'drain' | 'reconcile';
  sourceKey?: string;
  sourceUri?: string;
}

const CONFIG_FAILURES = new Set<string>([
  'ai_config_unavailable',
  'embedding_model_unavailable',
  'embedding_authentication_failed',
  'embedding_authorization_failed',
  'embedding_model_invalid',
  'embedding_request_invalid',
]);

export class RdfSearchReconciliationWorker {
  private readonly repository: RdfSearchReconciliationRepository;
  private readonly indexingService?: RdfSearchIndexingService;
  private readonly contextRegistry: RunAuthContextRegistry;
  private readonly store?: RdfSearchReconciliationWorkerOptions['store'];
  private readonly rdfEngine?: Pick<RdfEngineLike, 'listTextSources'>;
  private readonly workerId: string;
  private readonly now: () => number;
  private readonly leaseDurationMs: number;
  private readonly maxBatchSize: number;
  private readonly intervalMs: number;
  private readonly reconcileIntervalMs: number;
  private readonly retryBaseDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly sourcePageSize: number;
  private readonly onError?: RdfSearchReconciliationWorkerOptions['onError'];
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  public constructor(options: RdfSearchReconciliationWorkerOptions) {
    this.repository = options.repository;
    this.indexingService = options.indexingService;
    this.contextRegistry = options.contextRegistry;
    this.store = options.store;
    this.rdfEngine = options.rdfEngine;
    this.workerId = options.workerId ?? `rdf-search-reconciler-${randomUUID()}`;
    this.now = options.now ?? Date.now;
    this.leaseDurationMs = options.leaseDurationMs ?? 60_000;
    this.maxBatchSize = options.maxBatchSize ?? 10;
    this.intervalMs = options.intervalMs ?? 30_000;
    this.reconcileIntervalMs = options.reconcileIntervalMs ?? 120_000;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 60_000;
    this.retryMaxDelayMs = options.retryMaxDelayMs ?? 15 * 60_000;
    this.sourcePageSize = options.sourcePageSize ?? 1_000;
    this.onError = options.onError;
  }

  public start(): void {
    if (this.timer) {
      return;
    }
    let lastReconcileAt = 0;
    const tick = async (): Promise<void> => {
      if (this.running) {
        return;
      }
      this.running = true;
      try {
        const now = this.now();
        if (now - lastReconcileAt >= this.reconcileIntervalMs) {
          lastReconcileAt = now;
          await this.reconcileRememberedContexts();
        }
        await this.drain();
      } finally {
        this.running = false;
      }
    };
    this.timer = setInterval(() => {
      void tick().catch((error) => this.reportError(error, { phase: 'tick' }));
    }, this.intervalMs);
    void tick().catch((error) => this.reportError(error, { phase: 'tick' }));
  }

  public stop(): void {
    if (!this.timer) {
      return;
    }
    clearInterval(this.timer);
    this.timer = undefined;
  }

  public async drain(): Promise<RdfSearchReconciliationDrainResult> {
    if (!this.indexingService) {
      return { processed: 0 };
    }
    let processed = 0;
    for (let index = 0; index < this.maxBatchSize; index += 1) {
      const now = new Date(this.now());
      const row = await this.repository.claimNext(this.workerId, now, this.leaseDurationMs);
      if (!row) {
        break;
      }
      try {
        await this.process(row, now);
      } catch (error) {
        this.reportError(error, { phase: 'drain', sourceKey: row.sourceKey, sourceUri: row.sourceUri });
        try {
          await this.repository.markRetryable(
            row.sourceKey,
            this.workerId,
            'embedding_reconciliation_failed',
            this.nextAttemptAt(row, now),
            now,
          );
        } catch (retryError) {
          this.reportError(retryError, { phase: 'drain', sourceKey: row.sourceKey, sourceUri: row.sourceUri });
        }
      }
      processed += 1;
    }
    return { processed };
  }

  public async reconcileRememberedContexts(): Promise<RdfSearchRememberedContextReconciliationResult> {
    if (!this.rdfEngine?.listTextSources || !this.store) {
      return { contexts: 0, sources: 0 };
    }
    let contexts = 0;
    let sources = 0;
    const plannedScopes = new Map<string, RdfSearchDesiredProfile>();

    if (this.store) {
      for (const context of this.contextRegistry.list()) {
        const scope = sourcePrefixForContext(context);
        if (!scope) {
          continue;
        }
        try {
          const profile = await this.desiredProfile(context);
          if (profile) {
            plannedScopes.set(scope, profile);
          }
        } catch (error) {
          this.reportError(error, { phase: 'reconcile' });
        }
      }
    }

    for (const [scope, profile] of plannedScopes) {
      contexts += 1;
      let offset = 0;
      while (true) {
        let page: RdfTextSourceMetadata[];
        try {
          page = await this.rdfEngine.listTextSources({
            sourcePrefix: scope,
            limit: this.sourcePageSize,
            offset,
          });
        } catch (error) {
          this.reportError(error, { phase: 'reconcile' });
          break;
        }
        if (page.length === 0) {
          break;
        }
        for (const source of page) {
          try {
            await this.repository.upsertDesired({
              sourceKey: source.sourceKey ?? source.source,
              sourceUri: source.source,
              podRoot: source.workspace,
              sourceHash: source.sourceHash,
              sourceVersion: source.sourceVersion,
              ...profile,
              reason: 'embedding-config-observed',
            }, new Date(this.now()));
          } catch (error) {
            this.reportError(error, { phase: 'reconcile', sourceKey: source.sourceKey ?? source.source, sourceUri: source.source });
            continue;
          }
          sources += 1;
        }
        if (page.length < this.sourcePageSize) {
          break;
        }
        offset += page.length;
      }
    }
    return { contexts, sources };
  }

  private async process(row: RdfSearchReconciliationRow, now: Date): Promise<void> {
    const context = this.contextForSource(row.sourceUri);
    if (context) {
      const result = await this.indexingService!.rebuildVectorSource({
        context,
        sourceKey: row.sourceKey,
      });
      await this.recordResult(row, result, now);
      return;
    }

    await this.repository.markRetryable(
      row.sourceKey,
      this.workerId,
      'auth_context_unavailable',
      this.nextAttemptAt(row, now),
      now,
    );
  }

  private async recordResult(
    row: RdfSearchReconciliationRow,
    result: RdfVectorIndexingResult,
    now: Date,
  ): Promise<void> {
    if (result.status === 'indexed') {
      await this.repository.complete(row.sourceKey, this.workerId, now);
      return;
    }
    if (result.status === 'skipped') {
      if (result.reason === 'text_source_unavailable') {
        await this.repository.deleteSource(row.sourceKey);
        return;
      }
      if (CONFIG_FAILURES.has(result.reason)) {
        await this.repository.markBlockedConfig(row.sourceKey, this.workerId, result.reason, now);
      } else {
        await this.repository.markRetryable(
          row.sourceKey,
          this.workerId,
          result.reason,
          this.nextAttemptAt(row, now),
          now,
        );
      }
      return;
    }
    await this.repository.markRetryable(
      row.sourceKey,
      this.workerId,
      result.reason,
      this.nextAttemptAt(row, now),
      now,
    );
  }

  private contextForSource(sourceUri: string): StoreContext | undefined {
    return this.contextRegistry.list().find((context) => {
      const prefix = sourcePrefixForContext(context);
      return !!prefix && isUrlWithinPrefix(sourceUri, prefix);
    });
  }

  private async desiredProfile(context: StoreContext): Promise<RdfSearchDesiredProfile | undefined> {
    const config = await this.store?.getAiConfig(context);
    return config ? desiredProfileFromConfig(config) : undefined;
  }

  private nextAttemptAt(row: RdfSearchReconciliationRow, now: Date): Date {
    const exponent = Math.max(0, row.attemptCount);
    const delay = Math.min(this.retryMaxDelayMs, this.retryBaseDelayMs * (2 ** exponent));
    return new Date(now.getTime() + delay);
  }

  private reportError(error: unknown, input: RdfSearchReconciliationWorkerErrorInput): void {
    this.onError?.(error, input);
  }
}

function desiredProfileFromConfig(config: RdfSearchEmbeddingConfig): RdfSearchDesiredProfile | undefined {
  if (!config.apiKey || !config.embeddingModel) {
    return undefined;
  }
  const modelVersion = normalizeRdfVectorModelVersion(config.embeddingModelVersion);
  return {
    providerId: config.providerId,
    model: config.embeddingModel,
    modelVersion,
    configFingerprint: embeddingProfileFingerprint({
      providerId: config.providerId,
      embeddingModel: config.embeddingModel,
      embeddingModelVersion: modelVersion,
      credentialId: config.credentialId,
    }),
  };
}

function sourcePrefixForContext(context: StoreContext): string | undefined {
  const rdfAccessScope = context.rdfAccessScope as { basePath?: unknown } | undefined;
  if (typeof rdfAccessScope?.basePath === 'string' && rdfAccessScope.basePath) {
    return rdfAccessScope.basePath;
  }
  const auth = context.auth as AuthContext | undefined;
  if (!hasSolidClientCredentialsAuthority(auth)) {
    return undefined;
  }
  return solidPodRootFromWebId(auth.webId);
}

function solidPodRootFromWebId(webId: string): string | undefined {
  try {
    const url = new URL(webId);
    const marker = '/profile/card';
    const index = url.pathname.indexOf(marker);
    if (index < 0) {
      return undefined;
    }
    url.pathname = `${url.pathname.slice(0, index)}/`;
    url.hash = '';
    url.search = '';
    return url.href;
  } catch {
    return undefined;
  }
}

function isUrlWithinPrefix(sourceUri: string, rawPrefix: string): boolean {
  try {
    const source = new URL(sourceUri);
    const prefix = new URL(rawPrefix);
    if (source.origin !== prefix.origin) {
      return false;
    }
    const sourcePath = normalizeSourcePath(source.pathname);
    const prefixPath = normalizeDirectoryPath(prefix.pathname);
    return sourcePath === prefixPath.slice(0, -1) || sourcePath.startsWith(prefixPath);
  } catch {
    const prefix = rawPrefix.endsWith('/') ? rawPrefix : `${rawPrefix}/`;
    return sourceUri === rawPrefix || sourceUri.startsWith(prefix);
  }
}

function normalizeDirectoryPath(pathname: string): string {
  const normalized = normalizeSourcePath(pathname);
  return normalized.endsWith('/') ? normalized : `${normalized}/`;
}

function normalizeSourcePath(pathname: string): string {
  return pathname.startsWith('/') ? pathname : `/${pathname}`;
}

function embeddingProfileFingerprint(input: {
  providerId: string;
  embeddingModel: string;
  embeddingModelVersion?: string;
  credentialId: string;
}): string {
  return `sha256:${createHash('sha256')
    .update([
      input.providerId,
      input.embeddingModel,
      normalizeRdfVectorModelVersion(input.embeddingModelVersion),
      input.credentialId,
    ].join('\0'))
    .digest('hex')}`;
}
