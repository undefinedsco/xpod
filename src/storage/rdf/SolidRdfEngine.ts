import type { Quad } from '@rdfjs/types';
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
  RdfStorageStatsOptions,
} from './types';
import { RdfQuadIndex } from './RdfQuadIndex';
import { RdfTextIndex } from './RdfTextIndex';
import { RdfVectorIndex } from './RdfVectorIndex';
import { RdfQueryExecutor } from './RdfQueryExecutor';
import { LocalQleverRuntimeError } from './LocalQleverNativeSparqlClient';
import type { RdfQuery, RdfQueryResult } from './types';

type RdfTextIndexInput = RdfTextIndexSyncLike | RdfTextIndexOptions;
type RdfVectorIndexInput = RdfVectorIndexSyncLike | RdfVectorIndexOptions;

export interface LocalNativeSparqlClientLike {
  start(): void | Promise<void>;
  query(query: string, options: RdfNativeSparqlQueryOptions): RdfNativeSparqlResult | Promise<RdfNativeSparqlResult>;
  close(): void | Promise<void>;
}

export interface SolidRdfEngineOptions {
  index: RdfQuadIndex | RdfQuadIndexOptions;
  textIndex?: RdfTextIndexInput;
  vectorIndex?: RdfVectorIndexInput;
  nativeSparqlClient?: LocalNativeSparqlClientLike;
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
    this.nativeSparqlClient = options.nativeSparqlClient;
    if (options.autoOpen) {
      void this.open();
    }
  }

  public async open(): Promise<void> {
    this.index.open();
    this.textIndex?.open();
    this.vectorIndex?.open();
    await this.nativeSparqlClient?.start();
  }

  public async close(): Promise<void> {
    await this.nativeSparqlClient?.close();
    if (this.ownsVectorIndex) {
      this.vectorIndex?.close();
    }
    if (this.ownsTextIndex) {
      this.textIndex?.close();
    }
    if (this.ownsIndex) {
      this.index.close();
    }
  }

  public put(quads: Quad | Quad[], options?: RdfIndexPutOptions): void {
    this.index.multiPut(Array.isArray(quads) ? quads : [quads], options);
  }

  public replaceSource(quads: Quad[], source: RdfSourceInput): void {
    this.index.replaceSource(quads, source);
  }

  public deleteSource(source: string): number {
    return this.index.deleteSource(source);
  }

  public moveSource(oldSource: string, next: RdfSourceInput): number {
    return this.index.moveSource(oldSource, next);
  }

  public delete(pattern: QuintPattern): number {
    return this.index.delete(pattern);
  }

  public applyDelta(deletes: QuintPattern[], inserts: Quad[], options?: RdfIndexPutOptions): { deletedRows: number; insertedRows: number } {
    return this.index.applyDelta(deletes, inserts, options);
  }

  public rewriteTerms(input: RdfTermRewriteInput): RdfTermRewriteResult {
    return this.index.rewriteTerms(input);
  }

  public scan(query: RdfPatternQuery): RdfQuadIndexScanResult {
    return this.index.scan(query.pattern, query.options);
  }

  public query(query: RdfQuery): RdfQueryResult {
    return new RdfQueryExecutor(
      this.index,
      this.textIndex,
      this.vectorIndex,
    ).query(query);
  }

  public async sparqlQuery(
    query: string,
    options: RdfNativeSparqlQueryOptions,
  ): Promise<RdfNativeSparqlResult> {
    if (!this.nativeSparqlClient) {
      throw new LocalQleverRuntimeError(
        'qlever_runtime_unavailable',
        'Local QLever runtime is not configured',
      );
    }
    return this.nativeSparqlClient.query(query, options);
  }

  public refreshDerivedIndexes(_options?: RdfDerivedIndexRefreshOptions): RdfDerivedIndexRefreshResult {
    const factsDataVersion = this.index.dataVersion();
    return {
      derivedIndexProfile: 'baseline',
      factsDataVersion,
    };
  }

  public indexTextSource(source: RdfTextSourceInput, text: string, chunks?: RdfTextChunkInput[]): void {
    this.requireTextIndex().indexText(source, text, chunks);
  }

  public deleteTextSource(source: string): number {
    return this.requireTextIndex().deleteSource(source);
  }

  public moveTextSource(oldSource: string, next: RdfTextSourceInput): number {
    return this.requireTextIndex().moveSource(oldSource, next);
  }

  public listTextSources(options?: RdfTextSourceListOptions): RdfTextSourceMetadata[] {
    return this.requireTextIndex().listSources(options);
  }

  public searchText(options: RdfTextSearchOptions | string): RdfTextSearchResult[] {
    return this.requireTextIndex().search(typeof options === 'string' ? { query: options } : options);
  }

  public listTextSourceChunks(sourceKey: string): RdfTextSearchResult[] {
    return this.requireTextIndex().listSourceChunks(sourceKey);
  }

  public indexVectorSource(source: RdfVectorSourceInput, chunks: RdfVectorChunkInput[]): void {
    this.requireVectorIndex().indexVector(source, chunks);
  }

  public deleteVectorSource(source: string): number {
    return this.requireVectorIndex().deleteSource(source);
  }

  public moveVectorSource(oldSource: string, next: RdfVectorSourceInput): number {
    return this.requireVectorIndex().moveSource(oldSource, next);
  }

  public searchVector(options: RdfVectorSearchOptions): RdfVectorSearchResult[] {
    return this.requireVectorIndex().search(options);
  }

  public supportsPrimary(query: RdfPatternQuery): boolean {
    try {
      this.index.scan(query.pattern, { ...query.options, limit: 0 });
      return true;
    } catch {
      return false;
    }
  }

  public storageStats(_options?: RdfStorageStatsOptions): RdfEngineStorageStats {
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

function byteRatio(numerator: number, denominator: number): number {
  if (denominator <= 0) {
    return numerator <= 0 ? 1 : Number.POSITIVE_INFINITY;
  }
  return numerator / denominator;
}
