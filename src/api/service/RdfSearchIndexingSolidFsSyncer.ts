import type {
  SolidFsChange,
  SolidFsManifest,
  SolidFsPrepareInput,
  SolidFsSyncer,
} from '../../solidfs';
import { resolvePodResourceUrl } from '../../solidfs';
import {
  isLineAddressableRdf,
  isLineAddressableRdfPath,
  normalizeContentType,
} from '../../storage/rdf/RdfContentTypes';
import type { StoreContext } from '../chatkit/store';
import type {
  RdfSearchIndexingService,
  RdfVectorDeleteResult,
  RdfVectorIndexingResult,
} from './RdfSearchIndexingService';
import type { RdfSearchReconciliationRepository } from '../../search/RdfSearchReconciliationRepository';

export interface RdfSearchIndexingSolidFsSyncerOptions {
  service: RdfSearchIndexingService;
  /**
   * Derived vector indexing must not make an already-committed authority write
   * fail by default. Tests and operations can observe failures through onError.
   */
  failOnError?: boolean;
  onError?: (error: unknown, input: RdfSearchIndexingSolidFsSyncerErrorInput) => void;
  onResult?: (result: RdfVectorIndexingResult | RdfVectorDeleteResult) => void;
  reconciliationRepository?: Pick<
    RdfSearchReconciliationRepository,
    'upsertRetryable' | 'upsertBlockedConfig' | 'waitForConfig' | 'upsertApplied' | 'deleteSource'
  >;
  now?: () => number;
  retryDelayMs?: number;
}

export interface RdfSearchIndexingSolidFsSyncerErrorInput {
  change: SolidFsChange;
  workspace: SolidFsManifest;
  source?: string;
}

interface RdfSearchSourceIdentity {
  sourceHash?: string;
  sourceVersion?: string;
}

const BLOCKED_CONFIG_FAILURES = new Set<string>([
  'embedding_authentication_failed',
  'embedding_authorization_failed',
  'embedding_model_invalid',
  'embedding_request_invalid',
]);

export class RdfSearchIndexingSolidFsSyncer implements SolidFsSyncer {
  private readonly service: RdfSearchIndexingService;
  private readonly failOnError: boolean;
  private readonly onError?: RdfSearchIndexingSolidFsSyncerOptions['onError'];
  private readonly onResult?: RdfSearchIndexingSolidFsSyncerOptions['onResult'];
  private readonly reconciliationRepository?: RdfSearchIndexingSolidFsSyncerOptions['reconciliationRepository'];
  private readonly now: () => number;
  private readonly retryDelayMs: number;

  public constructor(options: RdfSearchIndexingSolidFsSyncerOptions) {
    this.service = options.service;
    this.failOnError = options.failOnError === true;
    this.onError = options.onError;
    this.onResult = options.onResult;
    this.reconciliationRepository = options.reconciliationRepository;
    this.now = options.now ?? Date.now;
    this.retryDelayMs = options.retryDelayMs ?? 60_000;
  }

  public shouldTrack(input: SolidFsPrepareInput): boolean {
    try {
      const url = new URL(input.workspace);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  }

  public shouldTrackPath(relativePath: string): boolean {
    return isSearchIndexablePath(relativePath);
  }

  public async sync(change: SolidFsChange, workspace: SolidFsManifest, context?: unknown): Promise<void> {
    if (!isSearchIndexableChange(change) || !isStoreContext(context)) {
      return;
    }

    const source = resolvePodResourceUrl(change, workspace);
    if (!source) {
      return;
    }

    try {
      if (change.type === 'deleted') {
        const result = await this.service.deleteVectorSource({ source });
        await this.reconciliationRepository?.deleteSource(source);
        this.onResult?.(result);
        return;
      }

      const result = await this.service.rebuildVectorSource({
        context,
        sourceKey: source,
      });
      await this.recordReconciliationResult(result, source, workspace.workspace);
      this.onResult?.(result);
    } catch (error) {
      this.onError?.(error, { change, workspace, source });
      if (this.failOnError) {
        throw error;
      }
    }
  }

  private async recordReconciliationResult(
    result: RdfVectorIndexingResult,
    source: string,
    podRoot: string,
  ): Promise<void> {
    const identity: RdfSearchSourceIdentity = {
      sourceHash: result.sourceHash,
      sourceVersion: result.sourceVersion,
    };
    if (result.status !== 'skipped') {
      if (result.status !== 'retryable') {
        if (hasAppliedEmbeddingProfile(result)) {
          await this.reconciliationRepository?.upsertApplied({
            sourceKey: source,
            sourceUri: source,
            podRoot,
            providerId: result.providerId,
            model: result.model,
            modelVersion: result.modelVersion,
            configFingerprint: result.configFingerprint,
            sourceHash: identity.sourceHash,
            sourceVersion: identity.sourceVersion,
            reason: 'source-indexed',
          });
        } else {
          await this.reconciliationRepository?.deleteSource(source);
        }
        return;
      }
      await this.reconciliationRepository?.upsertRetryable({
        sourceKey: source,
        sourceUri: source,
        podRoot,
        providerId: result.providerId,
        model: result.model,
        modelVersion: result.modelVersion,
        configFingerprint: result.configFingerprint,
        sourceHash: identity.sourceHash,
        sourceVersion: identity.sourceVersion,
        reason: result.reason,
        failureCategory: result.reason,
        nextAttemptAt: new Date(this.now() + this.retryDelayMs),
      });
      return;
    }
    if (result.reason === 'text_source_unavailable') {
      await this.reconciliationRepository?.deleteSource(source);
      return;
    }
    if (BLOCKED_CONFIG_FAILURES.has(result.reason)) {
      if (!hasBlockedEmbeddingProfile(result)) {
        return;
      }
      await this.reconciliationRepository?.upsertBlockedConfig({
        sourceKey: source,
        sourceUri: source,
        podRoot,
        providerId: result.providerId,
        model: result.model,
        modelVersion: result.modelVersion,
        configFingerprint: result.configFingerprint,
        sourceHash: identity.sourceHash,
        sourceVersion: identity.sourceVersion,
        reason: result.reason,
        failureCategory: result.reason,
      });
      return;
    }
    if (result.reason !== 'ai_config_unavailable' && result.reason !== 'embedding_model_unavailable') {
      return;
    }
    await this.reconciliationRepository?.waitForConfig({
      sourceKey: source,
      sourceUri: source,
      podRoot,
      sourceHash: identity.sourceHash,
      sourceVersion: identity.sourceVersion,
      reason: result.reason,
      failureCategory: result.reason,
    });
  }
}

function hasBlockedEmbeddingProfile(result: RdfVectorIndexingResult): result is RdfVectorIndexingResult & {
  providerId: string;
  model: string;
  configFingerprint: string;
} {
  return typeof result.providerId === 'string'
    && typeof result.model === 'string'
    && typeof result.configFingerprint === 'string';
}

function hasAppliedEmbeddingProfile(result: RdfVectorIndexingResult): result is RdfVectorIndexingResult & {
  status: 'indexed';
  providerId: string;
  model: string;
  configFingerprint: string;
} {
  return result.status === 'indexed'
    && typeof result.providerId === 'string'
    && typeof result.model === 'string'
    && typeof result.configFingerprint === 'string';
}

function isSearchIndexableChange(change: SolidFsChange): boolean {
  return isLineAddressableRdf(change.contentType, change.path)
    || isTextContentType(change.contentType)
    || isSearchIndexablePath(change.path);
}

function isSearchIndexablePath(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return isLineAddressableRdfPath(filePath)
    || lower.endsWith('.md')
    || lower.endsWith('.markdown')
    || lower.endsWith('.mdown')
    || lower.endsWith('.txt')
    || lower.endsWith('.log');
}

function isTextContentType(contentType: string | undefined): boolean {
  const normalized = normalizeContentType(contentType);
  return normalized === 'text/plain'
    || normalized === 'text/markdown'
    || normalized === 'text/x-markdown';
}

function isStoreContext(context: unknown): context is StoreContext {
  return typeof context === 'object' && context !== null;
}
