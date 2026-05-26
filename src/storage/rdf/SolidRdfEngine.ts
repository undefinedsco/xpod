import type { Quad } from '@rdfjs/types';
import { termToId } from 'n3';
import type { QuintPattern, QuintStore } from '../quint/types';
import { isTerm } from '../quint/types';
import type {
  Rdf3xShadowJoinResult,
  Rdf3xShadowScanResult,
  Rdf3xTripleIndexOptions,
  Rdf3xTriplePattern,
  RdfIndexPutOptions,
  RdfPatternQuery,
  RdfQuadJoinOptions,
  RdfQuadJoinPattern,
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
import { Rdf3xTripleIndex } from './Rdf3xTripleIndex';
import { RdfTextIndex } from './RdfTextIndex';
import { RdfVectorIndex } from './RdfVectorIndex';
import { RdfShadowComparator, diffQuads } from './RdfShadowComparator';
import { RdfLocalQueryEngine } from './RdfLocalQueryEngine';
import type { RdfLocalQuery, RdfLocalQueryResult } from './types';

export interface SolidRdfEngineOptions {
  index: RdfQuadIndex | RdfQuadIndexOptions;
  textIndex?: RdfTextIndex | RdfTextIndexOptions;
  vectorIndex?: RdfVectorIndex | RdfVectorIndexOptions;
  rdf3xIndex?: Rdf3xTripleIndex | Rdf3xTripleIndexOptions;
  compatibilityStore?: QuintStore;
  autoOpen?: boolean;
}

export class SolidRdfEngine {
  public readonly index: RdfQuadIndex;
  public readonly textIndex?: RdfTextIndex;
  public readonly vectorIndex?: RdfVectorIndex;
  public readonly rdf3xIndex?: Rdf3xTripleIndex;
  private readonly ownsIndex: boolean;
  private readonly ownsTextIndex: boolean;
  private readonly ownsVectorIndex: boolean;
  private readonly ownsRdf3xIndex: boolean;
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
    if (options.rdf3xIndex instanceof Rdf3xTripleIndex) {
      this.rdf3xIndex = options.rdf3xIndex;
      this.ownsRdf3xIndex = false;
    } else if (isRdf3xTripleIndexOptions(options.rdf3xIndex)) {
      this.rdf3xIndex = new Rdf3xTripleIndex(options.rdf3xIndex);
      this.ownsRdf3xIndex = true;
    } else {
      this.ownsRdf3xIndex = false;
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
    this.rdf3xIndex?.open();
  }

  public async close(): Promise<void> {
    if (this.ownsRdf3xIndex) {
      this.rdf3xIndex?.close();
    }
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

  public shadowRdf3xScan(query: RdfPatternQuery): Rdf3xShadowScanResult {
    const rdf3xIndex = this.requireRdf3xIndex();
    const rdf3xPattern = toRdf3xTriplePattern(query.pattern);
    const rebuild = rdf3xIndex.rebuildFromCurrentQuads();
    const primary = this.index.scan(query.pattern, query.options);
    const rdf3x = rdf3xIndex.scan(rdf3xPattern, query.options);
    const diff = diffQuads(rdf3x.quads, primary.quads);
    const orderedMatch = canonicalQuadKeys(primary.quads).join('\n') === canonicalQuadKeys(rdf3x.quads).join('\n');
    return {
      matched: diff.missingFromPrimary.length === 0 && diff.extraInPrimary.length === 0,
      orderedMatch,
      primary: primary.quads,
      rdf3x: rdf3x.quads,
      diff: {
        missingFromRdf3x: diff.extraInPrimary,
        extraInRdf3x: diff.missingFromPrimary,
      },
      primaryMetrics: primary.metrics,
      rdf3xMetrics: rdf3x.metrics,
      rebuild,
    };
  }

  public shadowRdf3xJoin(
    patterns: RdfQuadJoinPattern[],
    options?: RdfQuadJoinOptions,
  ): Rdf3xShadowJoinResult {
    const rdf3xIndex = this.requireRdf3xIndex();
    const rebuild = rdf3xIndex.rebuildFromCurrentQuads();
    const primary = this.index.joinPatterns(patterns, options);
    const rdf3x = rdf3xIndex.joinPatterns(patterns, options);
    const primaryKeys = primary.bindings.map(canonicalBindingKey);
    const rdf3xKeys = rdf3x.bindings.map(canonicalBindingKey);
    const diff = diffBindingKeys(rdf3xKeys, primaryKeys);
    return {
      matched: diff.missingFromRdf3x.length === 0 && diff.extraInRdf3x.length === 0,
      orderedMatch: primaryKeys.join('\n') === rdf3xKeys.join('\n'),
      primary: primary.bindings,
      rdf3x: rdf3x.bindings,
      diff,
      primaryMetrics: primary.metrics,
      rdf3xMetrics: rdf3x.metrics,
      rebuild,
    };
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

  private requireRdf3xIndex(): Rdf3xTripleIndex {
    if (!this.rdf3xIndex) {
      throw new Error('SolidRdfEngine RDF-3X shadow index is not configured');
    }
    return this.rdf3xIndex;
  }
}

function isRdfTextIndexOptions(input: RdfTextIndex | RdfTextIndexOptions | undefined): input is RdfTextIndexOptions {
  return input !== undefined && !(input instanceof RdfTextIndex) && typeof input.path === 'string';
}

function isRdfVectorIndexOptions(input: RdfVectorIndex | RdfVectorIndexOptions | undefined): input is RdfVectorIndexOptions {
  return input !== undefined && !(input instanceof RdfVectorIndex) && typeof input.path === 'string';
}

function isRdf3xTripleIndexOptions(input: Rdf3xTripleIndex | Rdf3xTripleIndexOptions | undefined): input is Rdf3xTripleIndexOptions {
  return input !== undefined && !(input instanceof Rdf3xTripleIndex) && typeof input.path === 'string';
}

function canonicalQuadKeys(quads: Quad[]): string[] {
  return quads.map((quad) => [
    termToId(quad.graph as any),
    termToId(quad.subject as any),
    termToId(quad.predicate as any),
    termToId(quad.object as any),
  ].join('\u001f'));
}

function canonicalBindingKey(binding: Record<string, unknown>): string {
  return Object.keys(binding)
    .sort()
    .map((key) => `${key}=${termToId(binding[key] as any)}`)
    .join('\u001f');
}

function diffBindingKeys(
  rdf3xKeys: string[],
  primaryKeys: string[],
): Rdf3xShadowJoinResult['diff'] {
  const rdf3xSet = new Set(rdf3xKeys);
  const primarySet = new Set(primaryKeys);
  return {
    missingFromRdf3x: Array.from(primarySet).filter((key) => !rdf3xSet.has(key)).sort(),
    extraInRdf3x: Array.from(rdf3xSet).filter((key) => !primarySet.has(key)).sort(),
  };
}

function toRdf3xTriplePattern(pattern: QuintPattern): Rdf3xTriplePattern {
  const result: Rdf3xTriplePattern = {};
  for (const key of ['graph', 'subject', 'predicate', 'object'] as const) {
    const value = pattern[key];
    if (!value) {
      continue;
    }
    if (!isTerm(value)) {
      if (key === 'graph' && isStartsWithOperator(value)) {
        result.graph = { $startsWith: value.$startsWith };
        continue;
      }
      throw new Error(`SolidRdfEngine RDF-3X shadow scan only supports exact ${key} terms${key === 'graph' ? ' or graph $startsWith' : ''}`);
    }
    result[key] = value;
  }
  return result;
}

function isStartsWithOperator(value: unknown): value is { $startsWith: string } {
  return value !== null
    && typeof value === 'object'
    && '$startsWith' in value
    && typeof (value as { $startsWith?: unknown }).$startsWith === 'string';
}
