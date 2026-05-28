import type { Quad, Term } from '@rdfjs/types';
import { termToId } from 'n3';
import type { QuintPattern, QuintStore } from '../quint/types';
import { isTerm } from '../quint/types';
import type {
  Rdf3xObjectOperatorPattern,
  Rdf3xShadowJoinResult,
  Rdf3xShadowScanResult,
  Rdf3xTermInPattern,
  Rdf3xTermMetadataPattern,
  Rdf3xTermNotInPattern,
  Rdf3xIndexOptions,
  Rdf3xTriplePattern,
  RdfDerivedIndexProfile,
  RdfEngineStorageStats,
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
import { Rdf3xIndex } from './Rdf3xIndex';
import { RdfTextIndex } from './RdfTextIndex';
import { RdfVectorIndex } from './RdfVectorIndex';
import { RdfShadowComparator, diffQuads } from './RdfShadowComparator';
import { RdfLocalQueryEngine } from './RdfLocalQueryEngine';
import type { RdfLocalQuery, RdfLocalQueryResult } from './types';

export interface SolidRdfEngineOptions {
  index: RdfQuadIndex | RdfQuadIndexOptions;
  derivedIndexProfile?: RdfDerivedIndexProfile;
  textIndex?: RdfTextIndex | RdfTextIndexOptions;
  vectorIndex?: RdfVectorIndex | RdfVectorIndexOptions;
  rdf3xIndex?: Rdf3xIndex | Rdf3xIndexOptions;
  rdf3xPrimary?: boolean;
  compatibilityStore?: QuintStore;
  autoOpen?: boolean;
}

export class SolidRdfEngine {
  public readonly index: RdfQuadIndex;
  public readonly textIndex?: RdfTextIndex;
  public readonly vectorIndex?: RdfVectorIndex;
  public readonly rdf3xIndex?: Rdf3xIndex;
  public readonly derivedIndexProfile: RdfDerivedIndexProfile;
  private readonly ownsIndex: boolean;
  private readonly ownsTextIndex: boolean;
  private readonly ownsVectorIndex: boolean;
  private readonly ownsRdf3xIndex: boolean;
  private readonly rdf3xPrimary: boolean;
  private readonly compatibilityStore?: QuintStore;
  private shadowComparator?: RdfShadowComparator;
  private readonly queryEngine: RdfLocalQueryEngine;
  private rdf3xDirty = true;
  private rdf3xDataVersion: number | undefined;

  public constructor(options: SolidRdfEngineOptions) {
    const indexOptions = isRdfQuadIndexOptions(options.index) ? options.index : undefined;
    const rdf3xIndexInput = normalizeOptionalRdf3xIndex(options.rdf3xIndex);
    this.derivedIndexProfile = resolveDerivedIndexProfile(options, indexOptions, rdf3xIndexInput);
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
    let autoConfiguredRdf3xPrimary = false;
    if (rdf3xIndexInput instanceof Rdf3xIndex) {
      this.rdf3xIndex = rdf3xIndexInput;
      this.ownsRdf3xIndex = false;
    } else if (isRdf3xIndexOptions(rdf3xIndexInput)) {
      this.rdf3xIndex = new Rdf3xIndex(rdf3xIndexInput);
      this.ownsRdf3xIndex = true;
    } else if (shouldAutoConfigureRdf3xIndex(this.derivedIndexProfile, rdf3xIndexInput, indexOptions)) {
      this.rdf3xIndex = new Rdf3xIndex({
        path: indexOptions.path,
        debug: indexOptions.debug,
      });
      this.ownsRdf3xIndex = true;
      autoConfiguredRdf3xPrimary = true;
    } else {
      this.ownsRdf3xIndex = false;
    }
    if (this.derivedIndexProfile === 'baseline' && this.rdf3xIndex) {
      throw new Error('SolidRdfEngine derivedIndexProfile=baseline cannot materialize an rdf3xIndex');
    }
    if (this.derivedIndexProfile === 'rdf3x' && !this.rdf3xIndex) {
      throw new Error('SolidRdfEngine derivedIndexProfile=rdf3x requires an rdf3xIndex or a file-backed index option');
    }
    if (options.rdf3xPrimary && !this.rdf3xIndex) {
      throw new Error('SolidRdfEngine rdf3xPrimary requires an rdf3xIndex or a file-backed index option');
    }
    this.rdf3xPrimary = options.rdf3xPrimary ?? autoConfiguredRdf3xPrimary;
    this.compatibilityStore = options.compatibilityStore;
    this.queryEngine = new RdfLocalQueryEngine(
      this.index,
      this.textIndex,
      this.vectorIndex,
      this.rdf3xPrimary ? this.rdf3xIndex : undefined,
    );
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
    this.markRdf3xDirty();
  }

  public replaceSource(quads: Quad[], source: RdfSourceInput): void {
    this.index.replaceSource(quads, source);
    this.markRdf3xDirty();
  }

  public deleteSource(source: string): number {
    const changes = this.index.deleteSource(source);
    if (changes > 0) {
      this.markRdf3xDirty();
    }
    return changes;
  }

  public delete(pattern: QuintPattern): number {
    const changes = this.index.delete(pattern);
    if (changes > 0) {
      this.markRdf3xDirty();
    }
    return changes;
  }

  public scan(query: RdfPatternQuery): RdfQuadIndexScanResult {
    return this.index.scan(query.pattern, query.options);
  }

  public query(query: RdfLocalQuery): RdfLocalQueryResult {
    this.refreshRdf3xPrimary();
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

  public storageStats(): RdfEngineStorageStats {
    const facts = this.index.stats();
    const rdf3x = this.rdf3xIndex
      ? {
          stats: this.rdf3xIndex.stats(),
          syncedWithFacts: this.rdf3xIndex.isSyncedWithCurrentQuads(),
        }
      : undefined;
    const factsBytes = facts.databaseBytes;
    const derivedBytes = rdf3x?.stats.databaseBytes ?? 0;
    const totalBytes = factsBytes + derivedBytes;
    return {
      derivedIndexProfile: this.derivedIndexProfile,
      facts,
      ...(rdf3x ? { rdf3x } : {}),
      factsBytes,
      derivedBytes,
      totalBytes,
      derivedToFactsRatio: byteRatio(derivedBytes, factsBytes),
      totalToFactsRatio: byteRatio(totalBytes, factsBytes),
    };
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

  private requireRdf3xIndex(): Rdf3xIndex {
    if (!this.rdf3xIndex) {
      throw new Error('SolidRdfEngine RDF-3X shadow index is not configured');
    }
    return this.rdf3xIndex;
  }

  private markRdf3xDirty(): void {
    if (this.rdf3xIndex) {
      this.rdf3xDirty = true;
    }
  }

  private refreshRdf3xPrimary(): void {
    if (!this.rdf3xPrimary) {
      return;
    }
    const dataVersion = this.index.dataVersion();
    const rdf3xIndex = this.requireRdf3xIndex();
    if (!this.rdf3xDirty && this.rdf3xDataVersion === dataVersion) {
      return;
    }
    if (rdf3xIndex.factsDataVersion() === dataVersion) {
      this.rdf3xDirty = false;
      this.rdf3xDataVersion = dataVersion;
      return;
    }
    const rebuild = rdf3xIndex.rebuildFromCurrentQuads();
    this.rdf3xDirty = false;
    this.rdf3xDataVersion = rebuild.factsDataVersion;
  }
}

function isRdfTextIndexOptions(input: RdfTextIndex | RdfTextIndexOptions | undefined): input is RdfTextIndexOptions {
  return input !== undefined && !(input instanceof RdfTextIndex) && typeof input.path === 'string';
}

function isRdfVectorIndexOptions(input: RdfVectorIndex | RdfVectorIndexOptions | undefined): input is RdfVectorIndexOptions {
  return input !== undefined && !(input instanceof RdfVectorIndex) && typeof input.path === 'string';
}

function isRdf3xIndexOptions(input: Rdf3xIndex | Rdf3xIndexOptions | undefined): input is Rdf3xIndexOptions {
  return input !== undefined && !(input instanceof Rdf3xIndex) && typeof input.path === 'string';
}

function isRdfQuadIndexOptions(input: RdfQuadIndex | RdfQuadIndexOptions): input is RdfQuadIndexOptions {
  return !(input instanceof RdfQuadIndex) && typeof input.path === 'string';
}

function resolveDerivedIndexProfile(
  options: SolidRdfEngineOptions,
  indexOptions: RdfQuadIndexOptions | undefined,
  rdf3xIndexInput: Rdf3xIndex | Rdf3xIndexOptions | undefined,
): RdfDerivedIndexProfile {
  if (options.derivedIndexProfile) {
    return options.derivedIndexProfile;
  }
  if (rdf3xIndexInput !== undefined || options.rdf3xPrimary === true) {
    return 'rdf3x';
  }
  if (options.rdf3xPrimary === false) {
    return 'baseline';
  }
  return indexOptions !== undefined && indexOptions.path !== ':memory:' ? 'rdf3x' : 'baseline';
}

function shouldAutoConfigureRdf3xIndex(
  profile: RdfDerivedIndexProfile,
  rdf3xIndexInput: Rdf3xIndex | Rdf3xIndexOptions | undefined,
  indexOptions: RdfQuadIndexOptions | undefined,
): indexOptions is RdfQuadIndexOptions {
  return profile === 'rdf3x'
    && rdf3xIndexInput === undefined
    && indexOptions !== undefined
    && indexOptions.path !== ':memory:';
}

function normalizeOptionalRdf3xIndex(input: Rdf3xIndex | Rdf3xIndexOptions | undefined): Rdf3xIndex | Rdf3xIndexOptions | undefined {
  if (input instanceof Rdf3xIndex || isRdf3xIndexOptions(input)) {
    return input;
  }
  return undefined;
}

function byteRatio(numerator: number, denominator: number): number {
  if (denominator <= 0) {
    return numerator <= 0 ? 1 : Number.POSITIVE_INFINITY;
  }
  return numerator / denominator;
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
      if (isRdf3xTermInPattern(value)) {
        result[key] = value;
        continue;
      }
      if (isRdf3xTermNotInPattern(value)) {
        result[key] = value;
        continue;
      }
      if (isRdf3xCompatibleOperatorPattern(key, value)) {
        result[key] = value as Rdf3xTriplePattern[typeof key];
        continue;
      }
      throw new Error(`SolidRdfEngine RDF-3X shadow scan only supports exact ${key} terms${key === 'graph' ? ' or graph $startsWith' : ''}`);
    }
    result[key] = value;
  }
  return result;
}

function isRdf3xTermInPattern(value: unknown): value is Rdf3xTermInPattern {
  return value !== null
    && typeof value === 'object'
    && !('termType' in value)
    && Object.keys(value).length === 1
    && Array.isArray((value as { $in?: unknown }).$in)
    && ((value as { $in: unknown[] }).$in).length > 0
    && ((value as { $in: unknown[] }).$in).every((entry) => isTerm(entry as any));
}

function isRdf3xTermNotInPattern(value: unknown): value is Rdf3xTermNotInPattern {
  return value !== null
    && typeof value === 'object'
    && !('termType' in value)
    && Object.keys(value).length === 1
    && Array.isArray((value as { $notIn?: unknown }).$notIn)
    && ((value as { $notIn: unknown[] }).$notIn).length > 0
    && ((value as { $notIn: unknown[] }).$notIn).every((entry) => isTerm(entry as any));
}

function isRdf3xCompatibleOperatorPattern(
  key: keyof Rdf3xTriplePattern,
  value: unknown,
): value is Rdf3xTermMetadataPattern | Rdf3xObjectOperatorPattern {
  if (value === null || typeof value !== 'object' || 'termType' in value) {
    return false;
  }
  const allowed = new Set<string>([
    '$in',
    '$notIn',
    '$termType',
    '$language',
    '$notLanguage',
    '$langMatches',
    '$datatype',
    '$notDatatype',
    ...(key === 'graph' ? ['$startsWith'] : []),
    ...(key === 'object' ? ['$gt', '$gte', '$lt', '$lte'] : []),
  ]);
  if (Object.keys(value).length === 0 || Object.keys(value).some((operator) => !allowed.has(operator))) {
    return false;
  }
  const operators = value as Record<string, unknown>;
  if (operators.$in !== undefined && !isRdf3xTermInPattern({ $in: operators.$in })) return false;
  if (operators.$notIn !== undefined && !isRdf3xTermNotInPattern({ $notIn: operators.$notIn })) return false;
  if (operators.$startsWith !== undefined && typeof operators.$startsWith !== 'string') return false;
  if (operators.$termType !== undefined && !['iri', 'blank', 'literal', 'numeric'].includes(operators.$termType as string)) return false;
  for (const languageOperator of ['$language', '$notLanguage', '$langMatches']) {
    if (operators[languageOperator] !== undefined && typeof operators[languageOperator] !== 'string') return false;
  }
  for (const datatypeOperator of ['$datatype', '$notDatatype']) {
    const datatype = operators[datatypeOperator];
    if (datatype !== undefined && (!isTerm(datatype as any) || (datatype as Term).termType !== 'NamedNode')) return false;
  }
  if (key === 'object') {
    for (const rangeOperator of ['$gt', '$gte', '$lt', '$lte']) {
      const rangeValue = operators[rangeOperator];
      if (rangeValue !== undefined && !isRdf3xObjectRangeValue(rangeValue)) return false;
    }
  }
  return true;
}

function isRdf3xObjectRangeValue(value: unknown): boolean {
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (typeof value === 'string') {
    return true;
  }
  return isTerm(value as any);
}
