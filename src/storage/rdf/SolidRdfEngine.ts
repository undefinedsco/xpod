import type { Quad, Term } from '@rdfjs/types';
import type { QuintPattern } from '../quint/types';
import type {
  RdfDerivedIndexRefreshOptions,
  RdfDerivedIndexRefreshResult,
  RdfEngineStorageStats,
  RdfIndexPutOptions,
  RdfPatternQuery,
  RdfQuadIndexOptions,
  RdfQuadIndexScanResult,
  RdfSourceInput,
  RdfTextChunkInput,
  RdfTextIndexOptions,
  RdfTextIndexSyncLike,
  RdfTextSourceListOptions,
  RdfTextSourceMetadata,
  RdfTextSearchOptions,
  RdfTextSearchResult,
  RdfTextSourceInput,
  RdfTermRewriteInput,
  RdfTermRewriteResult,
  RdfVectorChunkInput,
  RdfVectorIndexOptions,
  RdfVectorIndexSyncLike,
  RdfVectorSearchOptions,
  RdfVectorSearchResult,
  RdfVectorSourceInput,
  RdfEngineLike,
  RdfNativeSparqlQueryOptions,
  RdfNativeSparqlResult,
  RdfNativeQueryExecution,
  RdfStorageStatsOptions,
} from './types';
import { LocalPhysicalOperationService } from '../LocalPhysicalOperationService';
import { isAuthorityThenable } from '../AuthorityExclusionGate';
import { RdfQuadIndex } from './RdfQuadIndex';
import { RdfTextIndex } from './RdfTextIndex';
import { RdfVectorIndex } from './RdfVectorIndex';
import { RdfQueryExecutor } from './RdfQueryExecutor';
import { LocalQleverRuntimeError } from './LocalQleverNativeSparqlClient';
import {
  AuthorityPendingUnavailableError,
  graphUrlsMentionedInSparql,
  type AuthorityFreshnessProvider,
  type AuthorityFreshnessQuery,
} from '../AuthorityFreshnessService';
import type { RdfQuery, RdfQueryResult } from './types';

type RdfTextIndexInput = RdfTextIndexSyncLike | RdfTextIndexOptions;
type RdfVectorIndexInput = RdfVectorIndexSyncLike | RdfVectorIndexOptions;

export interface LocalNativeSparqlClientLike {
  start(): void | Promise<void>;
  query(query: string, options: RdfNativeSparqlQueryOptions): RdfNativeSparqlResult | Promise<RdfNativeSparqlResult>;
  close(): void | Promise<void>;
  createQueryExecution?(query: string, options: RdfNativeSparqlQueryOptions): RdfNativeQueryExecution;
}

export interface SolidRdfEngineOptions {
  index: RdfQuadIndex | RdfQuadIndexOptions;
  textIndex?: RdfTextIndexInput;
  vectorIndex?: RdfVectorIndexInput;
  nativeSparqlClient?: LocalNativeSparqlClientLike;
  /** Mandatory for configured Local serving; owns all index lifecycle. Omitted by isolated library consumers. */
  operationService?: LocalPhysicalOperationService;
  autoOpen?: boolean;
}

export class SolidRdfEngine implements RdfEngineLike {
  public readonly index: RdfQuadIndex;
  public readonly textIndex?: RdfTextIndexSyncLike;
  public readonly vectorIndex?: RdfVectorIndexSyncLike;
  private readonly ownsIndex: boolean;
  private readonly ownsTextIndex: boolean;
  private readonly ownsVectorIndex: boolean;
  private readonly nativeSparqlClient?: LocalNativeSparqlClientLike;
  private readonly operationService?: LocalPhysicalOperationService;
  private openPromise?: Promise<void>;
  private closePromise?: Promise<void>;
  private authorityFreshness?: AuthorityFreshnessProvider;

  public constructor(options: SolidRdfEngineOptions) {
    if (options.index instanceof RdfQuadIndex) {
      this.index = options.index;
      this.ownsIndex = false;
    } else {
      this.index = new RdfQuadIndex(options.index);
      this.ownsIndex = true;
    }
    if (isRdfTextIndexOptions(options.textIndex)) {
      this.textIndex = new RdfTextIndex(options.textIndex);
      this.ownsTextIndex = true;
    } else if (isRdfTextIndexLike(options.textIndex)) {
      this.textIndex = options.textIndex;
      this.ownsTextIndex = false;
    } else {
      this.ownsTextIndex = false;
    }
    if (isRdfVectorIndexOptions(options.vectorIndex)) {
      this.vectorIndex = new RdfVectorIndex(options.vectorIndex);
      this.ownsVectorIndex = true;
    } else if (isRdfVectorIndexLike(options.vectorIndex)) {
      this.vectorIndex = options.vectorIndex;
      this.ownsVectorIndex = false;
    } else {
      this.ownsVectorIndex = false;
    }
    this.operationService = options.operationService;
    this.nativeSparqlClient = options.nativeSparqlClient;
    if (this.operationService && this.nativeSparqlClient && !this.nativeSparqlClient.createQueryExecution) {
      throw new TypeError('Protected Local native execution requires actual-drain descriptors');
    }
    if (options.autoOpen) {
      void this.open();
    }
  }

  public open(): Promise<void> {
    if (this.operationService && this.closePromise) { return Promise.reject(new AuthorityPendingUnavailableError('Local RDF engine is closed')); }
    if (this.operationService && this.openPromise) { return this.openPromise; }
    const initialize = async (): Promise<void> => {
      this.index.open();
      this.textIndex?.open();
      this.vectorIndex?.open();
      if (this.operationService && this.nativeSparqlClient) {
        const startup = this.nativeSparqlClient.createQueryExecution!('ASK {}', { basePath: this.operationService.canonicalRoot });
        this.operationService.registerDrain(startup.drained);
        // Starting then cancelling binds the actual initialization lifetime without dispatching a query.
        void startup.result.catch(() => undefined);
        startup.start();
        startup.cancel();
      }
      try { await this.nativeSparqlClient?.start(); }
      catch (error) {
        // Failed readiness is not startup drain. Close the same owned client before releasing.
        await this.nativeSparqlClient?.close();
        throw error;
      }
    };
    if (!this.operationService) { return initialize(); }
    this.openPromise = this.operationService.run(initialize);
    return this.openPromise;
  }

  public close(): Promise<void> {
    const operations = this.operationService;
    if (!operations) {
      return (async () => { await this.nativeSparqlClient?.close(); this.closeIndexes(); })();
    }
    if (this.closePromise) { return this.closePromise; }
    operations.stop();
    this.closePromise = (async () => {
      await this.nativeSparqlClient?.close();
      await operations.close(() => this.closeIndexes());
    })();
    return this.closePromise;
  }

  private closeIndexes(): void {
    if (this.operationService || this.ownsVectorIndex) { this.vectorIndex?.close(); }
    if (this.operationService || this.ownsTextIndex) { this.textIndex?.close(); }
    if (this.operationService || this.ownsIndex) { this.index.close(); }
  }

  public put(quads: Quad | Quad[], options?: RdfIndexPutOptions): void {
    return this.runIndexSync(() => {
      this.index.multiPut(Array.isArray(quads) ? quads : [quads], options);
    });
  }

  public replaceSource(quads: Quad[], source: RdfSourceInput): void {
    return this.runIndexSync(() => {
      this.index.replaceSource(quads, source);
    });
  }

  public deleteSource(source: string): number {
    return this.runIndexSync(() => {
      return this.index.deleteSource(source);
    });
  }

  public moveSource(oldSource: string, next: RdfSourceInput): number {
    return this.runIndexSync(() => {
      return this.index.moveSource(oldSource, next);
    });
  }

  public delete(pattern: QuintPattern): number {
    return this.runIndexSync(() => {
      return this.index.delete(pattern);
    });
  }

  public applyDelta(deletes: QuintPattern[], inserts: Quad[], options?: RdfIndexPutOptions): { deletedRows: number; insertedRows: number } {
    return this.runIndexSync(() => {
      return this.index.applyDelta(deletes, inserts, options);
    });
  }

  public rewriteTerms(input: RdfTermRewriteInput): RdfTermRewriteResult {
    return this.runIndexSync(() => {
      return this.index.rewriteTerms(input);
    });
  }

  public scan(query: RdfPatternQuery): RdfQuadIndexScanResult {
    return this.runIndexSync(() => {
      if (this.operationService) {
        this.assertSynchronousAuthorityFresh(embeddedAuthorityFreshnessQuery({ patterns: [query.pattern] }));
      }
      return this.index.scan(query.pattern, query.options);
    });
  }

  public query(query: RdfQuery): RdfQueryResult {
    const execute = (): RdfQueryResult => {
      this.assertEmbeddedAuthorityFresh(query);
      return new RdfQueryExecutor(this.index, this.textIndex, this.vectorIndex).query(query);
    };
    return this.operationService ? this.operationService.runSync(execute) : execute();
  }

  /**
   * Synchronous embedded-read freshness. Only the explicit `assertFreshSync` capability is invoked;
   * the async `assertFresh` is never started or ignored here. A provider without the synchronous
   * capability cannot prove freshness for a synchronous read, so the read is refused conservatively.
   */
  private assertEmbeddedAuthorityFresh(query: RdfQuery): void {
    this.assertSynchronousAuthorityFresh(embeddedAuthorityFreshnessQuery(query));
  }

  /** One provider proof shared by configured direct accessors and Engine read entrypoints. */
  public assertAuthorityFreshSync(query: AuthorityFreshnessQuery): void {
    this.runIndexSync(() => this.assertSynchronousAuthorityFresh(query));
  }

  private assertSynchronousAuthorityFresh(query: AuthorityFreshnessQuery): void {
    const provider = this.authorityFreshness;
    if (!provider) {
      return;
    }
    if (!provider.assertFreshSync) {
      throw new AuthorityPendingUnavailableError(
        'Synchronous authority freshness cannot be proven for this embedded query',
      );
    }
    const freshness = provider.assertFreshSync(query);
    if (isAuthorityThenable(freshness)) {
      void Promise.resolve(freshness).catch(() => undefined);
      this.operationService?.retainUnconfirmedProducer();
      throw new AuthorityPendingUnavailableError('Synchronous authority freshness returned an unqualified thenable');
    }
  }

  /**
   * Attach the shared derived-index freshness contract. Configured storage components (Mix's journal
   * wired through SolidRdfDataAccessor) install this so native/conditional reads observe the same
   * pending state as ordinary Mix reads.
   */
  public setAuthorityFreshnessProvider(provider: AuthorityFreshnessProvider): void {
    this.authorityFreshness = provider;
  }

  public async sparqlQuery(
    query: string,
    options: RdfNativeSparqlQueryOptions,
  ): Promise<RdfNativeSparqlResult> {
    const execute = async (): Promise<RdfNativeSparqlResult> => {
      if (this.operationService) {
        this.assertSynchronousAuthorityFresh(authorityFreshnessQueryFor(query, options));
      } else if (this.authorityFreshness) {
        await this.authorityFreshness.assertFresh(authorityFreshnessQueryFor(query, options));
      }
      const client = this.nativeSparqlClient;
      if (!client) {
        throw new LocalQleverRuntimeError('qlever_runtime_unavailable', 'Local QLever runtime is not configured');
      }
      if (!this.operationService) {
        // Isolated library transport compatibility; configured Local always injects the service.
        return client.query(query, options);
      }
      if (!client.createQueryExecution) {
        throw new AuthorityPendingUnavailableError('Local native execution has no actual-drain descriptor');
      }
      const execution = client.createQueryExecution(query, options);
      this.operationService.registerDrain(execution.drained);
      execution.start();
      return execution.result;
    };
    return this.operationService ? this.operationService.run(execute) : execute();
  }

  public refreshDerivedIndexes(_options?: RdfDerivedIndexRefreshOptions): RdfDerivedIndexRefreshResult {
    return this.runIndexSync(() => {
      const factsDataVersion = this.index.dataVersion();
      return {
        derivedIndexProfile: 'baseline',
        factsDataVersion,
      };
    });
  }

  public indexTextSource(source: RdfTextSourceInput, text: string, chunks?: RdfTextChunkInput[]): void {
    return this.runIndexSync(() => {
      this.requireTextIndex().indexText(source, text, chunks);
    });
  }

  public deleteTextSource(source: string): number {
    return this.runIndexSync(() => {
      return this.requireTextIndex().deleteSource(source);
    });
  }

  public moveTextSource(oldSource: string, next: RdfTextSourceInput): number {
    return this.runIndexSync(() => {
      return this.requireTextIndex().moveSource(oldSource, next);
    });
  }

  public listTextSources(options?: RdfTextSourceListOptions): RdfTextSourceMetadata[] {
    return this.runIndexSync(() => {
      if (this.operationService) { this.assertSynchronousAuthorityFresh({ unbounded: true }); }
      return this.requireTextIndex().listSources(options);
    });
  }

  public searchText(options: RdfTextSearchOptions | string): RdfTextSearchResult[] {
    return this.runIndexSync(() => {
      if (this.operationService) { this.assertSynchronousAuthorityFresh({ unbounded: true }); }
      return this.requireTextIndex().search(typeof options === 'string' ? { query: options } : options);
    });
  }

  public listTextSourceChunks(sourceKey: string): RdfTextSearchResult[] {
    return this.runIndexSync(() => {
      if (this.operationService) { this.assertSynchronousAuthorityFresh({ unbounded: true }); }
      return this.requireTextIndex().listSourceChunks(sourceKey);
    });
  }

  public indexVectorSource(source: RdfVectorSourceInput, chunks: RdfVectorChunkInput[]): void {
    return this.runIndexSync(() => {
      this.requireVectorIndex().indexVector(source, chunks);
    });
  }

  public deleteVectorSource(source: string): number {
    return this.runIndexSync(() => {
      return this.requireVectorIndex().deleteSource(source);
    });
  }

  public moveVectorSource(oldSource: string, next: RdfVectorSourceInput): number {
    return this.runIndexSync(() => {
      return this.requireVectorIndex().moveSource(oldSource, next);
    });
  }

  public searchVector(options: RdfVectorSearchOptions): RdfVectorSearchResult[] {
    return this.runIndexSync(() => {
      if (this.operationService) { this.assertSynchronousAuthorityFresh({ unbounded: true }); }
      return this.requireVectorIndex().search(options);
    });
  }

  public supportsPrimary(query: RdfPatternQuery): boolean {
    return this.runIndexSync(() => {
      try {
        this.index.scan(query.pattern, { ...query.options, limit: 0 });
        return true;
      } catch {
        return false;
      }
    });
  }

  public storageStats(_options?: RdfStorageStatsOptions): RdfEngineStorageStats {
    return this.runIndexSync(() => {
      if (this.operationService) { this.assertSynchronousAuthorityFresh({ unbounded: true }); }
      const facts = this.index.stats();
      const factsBytes = facts.databaseBytes;
      const derivedBytes = 0;
      const totalBytes = factsBytes + derivedBytes;
      return {
        derivedIndexProfile: 'baseline',
        facts,
        factsBytes,
        derivedBytes,
        totalBytes,
        derivedToFactsRatio: byteRatio(derivedBytes, factsBytes),
        totalToFactsRatio: byteRatio(totalBytes, factsBytes),
      };
    });
  }

  private runIndexSync<T>(callback: () => T): T {
    return this.operationService ? this.operationService.runSync(callback) : callback();
  }

  private requireTextIndex(): RdfTextIndexSyncLike {
    if (!this.textIndex) {
      throw new Error('SolidRdfEngine text index is not configured');
    }
    return this.textIndex;
  }

  private requireVectorIndex(): RdfVectorIndexSyncLike {
    if (!this.vectorIndex) {
      throw new Error('SolidRdfEngine vector index is not configured');
    }
    return this.vectorIndex;
  }
}

function isRdfTextIndexOptions(input: RdfTextIndexInput | undefined): input is RdfTextIndexOptions {
  return input !== undefined && typeof (input as RdfTextIndexOptions).path === 'string'
    && !isRdfTextIndexLike(input);
}

function isRdfTextIndexLike(input: RdfTextIndexInput | undefined): input is RdfTextIndexSyncLike {
  return input !== undefined
    && typeof (input as Partial<RdfTextIndexSyncLike>).indexText === 'function'
    && typeof (input as Partial<RdfTextIndexSyncLike>).search === 'function';
}

function isRdfVectorIndexOptions(input: RdfVectorIndexInput | undefined): input is RdfVectorIndexOptions {
  return input !== undefined && typeof (input as RdfVectorIndexOptions).path === 'string'
    && !isRdfVectorIndexLike(input);
}

function isRdfVectorIndexLike(input: RdfVectorIndexInput | undefined): input is RdfVectorIndexSyncLike {
  return input !== undefined
    && typeof (input as Partial<RdfVectorIndexSyncLike>).indexVector === 'function'
    && typeof (input as Partial<RdfVectorIndexSyncLike>).search === 'function';
}

function isRdfQuadIndexOptions(input: RdfQuadIndex | RdfQuadIndexOptions): input is RdfQuadIndexOptions {
  return !(input instanceof RdfQuadIndex) && typeof input.path === 'string';
}

function authorityFreshnessQueryFor(
  query: string,
  options: RdfNativeSparqlQueryOptions,
): AuthorityFreshnessQuery {
  const graphUrls = new Set<string>(graphUrlsMentionedInSparql(query));
  const resourceUrls = new Set<string>();
  for (const url of options.accessScope?.allowedGraphUrls ?? []) {
    graphUrls.add(url);
  }
  for (const url of options.accessScope?.allowedSourceUrls ?? []) {
    resourceUrls.add(url);
  }
  if (options.sourceUri) {
    resourceUrls.add(options.sourceUri);
  }
  return {
    basePath: options.basePath,
    graphUrls: [ ...graphUrls ],
    resourceUrls: [ ...resourceUrls ],
  };
}

function embeddedAuthorityFreshnessQuery(query: RdfQuery): AuthorityFreshnessQuery {
  const graphUrls = new Set<string>();
  let unbounded = (query.unions?.length ?? 0) > 0
    || (query.minus?.length ?? 0) > 0
    || (query.exists?.length ?? 0) > 0
    || (query.optional?.length ?? 0) > 0
    || (query.textSearch?.length ?? 0) > 0
    || (query.vectorSearch?.length ?? 0) > 0;
  for (const pattern of query.patterns ?? []) {
    const graph = pattern.graph;
    if (graph && typeof graph === 'object' && 'termType' in graph && (graph as Term).termType === 'NamedNode') {
      const graphUrl = (graph as Term).value;
      // Metadata is a derived graph of its authority resource; container facts include descendants.
      const resourceUrl = graphUrl.startsWith('meta:') ? graphUrl.slice(5) : graphUrl;
      graphUrls.add(resourceUrl);
      if (!graphUrl.startsWith('meta:') && resourceUrl.endsWith('/')) { unbounded = true; }
    } else {
      unbounded = true;
    }
  }
  if (graphUrls.size === 0) {
    unbounded = true;
  }
  return { graphUrls: [ ...graphUrls ], unbounded };
}

function byteRatio(numerator: number, denominator: number): number {
  if (denominator <= 0) {
    return numerator <= 0 ? 1 : Number.POSITIVE_INFINITY;
  }
  return numerator / denominator;
}
