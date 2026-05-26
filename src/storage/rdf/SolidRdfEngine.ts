import type { Quad } from '@rdfjs/types';
import type { QuintPattern, QuintStore } from '../quint/types';
import type {
  RdfIndexPutOptions,
  RdfPatternQuery,
  RdfQuadIndexOptions,
  RdfQuadIndexScanResult,
  RdfSourceInput,
  RdfShadowScanResult,
  RdfTextChunkInput,
  RdfTextIndexOptions,
  RdfTextSearchOptions,
  RdfTextSearchResult,
  RdfTextSourceInput,
  RdfVectorChunkInput,
  RdfVectorIndexOptions,
  RdfVectorSearchOptions,
  RdfVectorSearchResult,
  RdfVectorSourceInput,
} from './types';
import { RdfQuadIndex } from './RdfQuadIndex';
import { RdfTextIndex } from './RdfTextIndex';
import { RdfVectorIndex } from './RdfVectorIndex';
import { RdfShadowComparator } from './RdfShadowComparator';
import { RdfLocalQueryEngine } from './RdfLocalQueryEngine';
import type { RdfLocalQuery, RdfLocalQueryResult } from './types';

export interface SolidRdfEngineOptions {
  index: RdfQuadIndex | RdfQuadIndexOptions;
  textIndex?: RdfTextIndex | RdfTextIndexOptions;
  vectorIndex?: RdfVectorIndex | RdfVectorIndexOptions;
  compatibilityStore?: QuintStore;
  autoOpen?: boolean;
}

export class SolidRdfEngine {
  public readonly index: RdfQuadIndex;
  public readonly textIndex?: RdfTextIndex;
  public readonly vectorIndex?: RdfVectorIndex;
  private readonly ownsIndex: boolean;
  private readonly ownsTextIndex: boolean;
  private readonly ownsVectorIndex: boolean;
  private readonly compatibilityStore?: QuintStore;
  private shadowComparator?: RdfShadowComparator;
  private readonly queryEngine: RdfLocalQueryEngine;

  public constructor(options: SolidRdfEngineOptions) {
    if (options.index instanceof RdfQuadIndex) {
      this.index = options.index;
      this.ownsIndex = false;
    } else {
      this.index = new RdfQuadIndex(options.index);
      this.ownsIndex = true;
    }
    if (options.textIndex instanceof RdfTextIndex) {
      this.textIndex = options.textIndex;
      this.ownsTextIndex = false;
    } else if (isRdfTextIndexOptions(options.textIndex)) {
      this.textIndex = new RdfTextIndex(options.textIndex);
      this.ownsTextIndex = true;
    } else {
      this.ownsTextIndex = false;
    }
    if (options.vectorIndex instanceof RdfVectorIndex) {
      this.vectorIndex = options.vectorIndex;
      this.ownsVectorIndex = false;
    } else if (isRdfVectorIndexOptions(options.vectorIndex)) {
      this.vectorIndex = new RdfVectorIndex(options.vectorIndex);
      this.ownsVectorIndex = true;
    } else {
      this.ownsVectorIndex = false;
    }
    this.compatibilityStore = options.compatibilityStore;
    this.queryEngine = new RdfLocalQueryEngine(this.index, this.textIndex, this.vectorIndex);
    if (this.compatibilityStore) {
      this.shadowComparator = new RdfShadowComparator(this.index, this.compatibilityStore);
    }
    if (options.autoOpen) {
      this.open();
    }
  }

  public open(): void {
    this.index.open();
    this.textIndex?.open();
    this.vectorIndex?.open();
  }

  public async close(): Promise<void> {
    if (this.ownsVectorIndex) {
      this.vectorIndex?.close();
    }
    if (this.ownsTextIndex) {
      this.textIndex?.close();
    }
    if (this.ownsIndex) {
      this.index.close();
    }
    if (this.compatibilityStore) {
      await this.compatibilityStore.close();
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

  public delete(pattern: QuintPattern): number {
    return this.index.delete(pattern);
  }

  public scan(query: RdfPatternQuery): RdfQuadIndexScanResult {
    return this.index.scan(query.pattern, query.options);
  }

  public query(query: RdfLocalQuery): RdfLocalQueryResult {
    return this.queryEngine.query(query);
  }

  public indexTextSource(source: RdfTextSourceInput, text: string, chunks?: RdfTextChunkInput[]): void {
    this.requireTextIndex().indexText(source, text, chunks);
  }

  public deleteTextSource(source: string): number {
    return this.requireTextIndex().deleteSource(source);
  }

  public searchText(options: RdfTextSearchOptions | string): RdfTextSearchResult[] {
    return this.requireTextIndex().search(typeof options === 'string' ? { query: options } : options);
  }

  public indexVectorSource(source: RdfVectorSourceInput, chunks: RdfVectorChunkInput[]): void {
    this.requireVectorIndex().indexVector(source, chunks);
  }

  public deleteVectorSource(source: string): number {
    return this.requireVectorIndex().deleteSource(source);
  }

  public searchVector(options: RdfVectorSearchOptions): RdfVectorSearchResult[] {
    return this.requireVectorIndex().search(options);
  }

  public async shadowScan(query: RdfPatternQuery): Promise<RdfShadowScanResult> {
    if (!this.shadowComparator) {
      throw new Error('SolidRdfEngine shadowScan requires a compatibility QuintStore');
    }
    return this.shadowComparator.compareScan(query);
  }

  public supportsPrimary(query: RdfPatternQuery): boolean {
    try {
      this.index.scan(query.pattern, { ...query.options, limit: 0 });
      return true;
    } catch {
      return false;
    }
  }

  private requireTextIndex(): RdfTextIndex {
    if (!this.textIndex) {
      throw new Error('SolidRdfEngine text index is not configured');
    }
    return this.textIndex;
  }

  private requireVectorIndex(): RdfVectorIndex {
    if (!this.vectorIndex) {
      throw new Error('SolidRdfEngine vector index is not configured');
    }
    return this.vectorIndex;
  }
}

function isRdfTextIndexOptions(input: RdfTextIndex | RdfTextIndexOptions | undefined): input is RdfTextIndexOptions {
  return input !== undefined && !(input instanceof RdfTextIndex) && typeof input.path === 'string';
}

function isRdfVectorIndexOptions(input: RdfVectorIndex | RdfVectorIndexOptions | undefined): input is RdfVectorIndexOptions {
  return input !== undefined && !(input instanceof RdfVectorIndex) && typeof input.path === 'string';
}
