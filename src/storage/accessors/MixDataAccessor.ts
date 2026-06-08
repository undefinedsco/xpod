import { Readable } from 'stream';
import { getLoggerFor } from 'global-logger-factory';
import arrayifyStream from 'arrayify-stream';
import { DataFactory, Parser, Writer, termToId } from 'n3';
import jsonld from 'jsonld';
import { rdfParser } from 'rdf-parse';
import { Parser as SparqlParser } from 'sparqljs';

import type { Quad, Term } from '@rdfjs/types';
import {
  isContainerIdentifier,
  RepresentationMetadata,
  INTERNAL_QUADS,
  FoundHttpError,
  NotFoundHttpError,
  POSIX,
  SOLID_META,
  XSD,
  toLiteral,
  guardStream,
  addResourceMetadata,
  updateModifiedDate,
} from '@solid/community-server';
import type {
  Representation,
  ResourceIdentifier,
  Guarded,
  DataAccessor,
} from '@solid/community-server';
import {
  RdfSparqlAdapter,
  UnsupportedSparqlQueryError,
  type RdfSparqlUpdateDeltaOperation,
} from '../rdf/RdfSparqlAdapter';
import {
  isLineAddressableRdfPath,
  isRdfDocumentPath,
  rdfContentTypeForPath,
} from '../rdf/RdfContentTypes';
import { RdfQuadIndex } from '../rdf/RdfQuadIndex';
import { serializeRdfXml } from '../rdf/RdfXmlSerializer';
import { SolidRdfEngine } from '../rdf/SolidRdfEngine';
import type {
  RdfBindingRow,
  RdfQuery,
  RdfQueryPattern,
  RdfQueryTermPattern,
  RdfSourceInput,
  RdfValuesBindingSource,
} from '../rdf/types';
import { metadataRequestContext } from '../MetadataRequestContext';

export interface LocalRdfDocument {
  data: Guarded<Readable>;
  metadata: RepresentationMetadata;
}

export interface LocalRdfReadableAccessor {
  getLocalRdfDocument(identifier: ResourceIdentifier): Promise<LocalRdfDocument>;
}

export interface LocalRdfIndexAccessor {
  syncLocalRdfDocument(
    identifier: ResourceIdentifier,
    data?: Guarded<Readable>,
    contentType?: string,
    options?: LocalRdfSyncOptions,
  ): Promise<void>;
  deleteLocalRdfIndex(identifier: ResourceIdentifier): Promise<void>;
}

export interface LocalRdfSyncOptions {
  source?: string;
  workspace?: string;
  localPath?: string;
  sourceVersion?: string;
}

export interface SourceScopedStructuredRdfAccessor {
  writeRdfSourceDocument(
    identifier: ResourceIdentifier,
    quads: Quad[],
    metadata: RepresentationMetadata,
    source: RdfSourceInput,
  ): Promise<void>;
  deleteRdfSourceDocument(identifier: ResourceIdentifier): Promise<void>;
}

interface LocalRdfGraphState {
  quads: Quad[];
  existed: boolean;
}

interface LocalRdfAuthorityPatch {
  identifier: ResourceIdentifier;
  previousQuads: Quad[];
  previousExists: boolean;
  nextQuads: Quad[];
}

/**
 * MixDataAccessor - Routes data to appropriate storage based on content type
 * 
 * - RDF data (internal/quads) -> structuredDataAccessor (Solid RDF engine by default)
 * - RDF file mirrors (.ttl/.jsonld) -> rdfFileDataAccessor (local FileSystem)
 * - Other data (binary, text, etc.) -> unstructuredDataAccessor (FileSystem, Minio, etc.)
 * 
 * This uses composition instead of inheritance, allowing any DataAccessor
 * to be used as the RDF storage backend.
 */
export class MixDataAccessor implements DataAccessor {
  protected readonly logger = getLoggerFor(this);
  private readonly rdfSparqlAdapter = new RdfSparqlAdapter();
  
  private readonly structuredDataAccessor: DataAccessor;
  private readonly unstructuredDataAccessor: DataAccessor;
  private readonly rdfFileDataAccessor: DataAccessor;
  private readonly presignedRedirectEnabled: boolean;
  private readonly mirrorContainersToUnstructured: boolean;

  constructor(
    structuredDataAccessor: DataAccessor,
    unstructuredDataAccessor: DataAccessor,
    presignedRedirectEnabled = false,
    mirrorContainersToUnstructured = true,
    rdfFileDataAccessor: DataAccessor = unstructuredDataAccessor,
  ) {
    this.structuredDataAccessor = structuredDataAccessor;
    this.unstructuredDataAccessor = unstructuredDataAccessor;
    this.rdfFileDataAccessor = rdfFileDataAccessor;
    this.presignedRedirectEnabled = presignedRedirectEnabled;
    this.mirrorContainersToUnstructured = mirrorContainersToUnstructured;
  }

  /**
   * This accessor supports all types of data.
   */
  public async canHandle(representation: Representation): Promise<void> {
    return void 0;
  }

  /**
   * Checks if the given representation is unstructured (non-RDF).
   */
  private isUnstructured(metadata: RepresentationMetadata): boolean {
    return metadata.contentType !== INTERNAL_QUADS;
  }

  public async getData(identifier: ResourceIdentifier): Promise<Guarded<Readable>> {
    const metadata = await this.getMetadata(identifier);
    if (this.isUnstructured(metadata)) {
      // When presigned redirect is enabled and the unstructured accessor supports it,
      // generate a presigned URL and throw FoundHttpError to trigger a 302 redirect.
      if (this.presignedRedirectEnabled) {
        const accessor = this.unstructuredDataAccessor as { getPresignedUrl?: (id: ResourceIdentifier, expires?: number) => Promise<string> };
        if (typeof accessor.getPresignedUrl === 'function') {
          const presignedUrl = await accessor.getPresignedUrl(identifier);
          this.logger.debug(`Presigned redirect: ${identifier.path}`);
          throw new FoundHttpError(presignedUrl);
        }
      }
      return await this.unstructuredDataAccessor.getData(identifier);
    }
    return await this.structuredDataAccessor.getData(identifier);
  }

  /**
   * Read the local RDF file mirror used by SolidFS/local-first HTTP reads.
   *
   * `getData()` intentionally keeps returning the structured quad stream for
   * CSS internals. This method is the explicit file-content path for callers
   * that need a real Turtle/JSON-LD byte stream.
   */
  public async getLocalRdfDocument(identifier: ResourceIdentifier): Promise<LocalRdfDocument> {
    if (isContainerIdentifier(identifier)) {
      throw new NotFoundHttpError();
    }

    if (this.isByLineRdfIdentifier(identifier)) {
      try {
        return {
          data: await this.rdfFileDataAccessor.getData(identifier),
          metadata: await this.getExistingLocalRdfMetadata(identifier),
        };
      } catch (error) {
        if (!NotFoundHttpError.isInstance(error)) {
          throw error;
        }
      }
    }

    const metadata = await this.getMetadata(identifier);
    if (!this.isLocalMirroredRdf(identifier, metadata)) {
      throw new NotFoundHttpError();
    }

    try {
      return {
        data: await this.rdfFileDataAccessor.getData(identifier),
        metadata: await this.getLocalRdfMetadata(identifier, metadata),
      };
    } catch (error) {
      if (!NotFoundHttpError.isInstance(error)) {
        throw error;
      }
    }

    await this.refreshLocalRdfMirror(identifier);

    return {
      data: await this.rdfFileDataAccessor.getData(identifier),
      metadata: await this.getLocalRdfMetadata(identifier, metadata),
    };
  }

  public async getMetadata(identifier: ResourceIdentifier): Promise<RepresentationMetadata> {
    const cache = metadataRequestContext.getStore()?.metadataCache;
    const cacheKey = identifier.path;
    const cached = cache?.get(cacheKey);
    if (cached) {
      if (cached.kind === 'miss') {
        throw new NotFoundHttpError();
      }
      return new RepresentationMetadata(cached.metadata);
    }

    try {
      const metadata = await this.structuredDataAccessor.getMetadata(identifier);

      if (!metadata.contentType) {
        metadata.contentType = INTERNAL_QUADS;
      }

      cache?.set(cacheKey, { kind: 'hit', metadata: new RepresentationMetadata(metadata) });
      return metadata;
    } catch (error) {
      if (NotFoundHttpError.isInstance(error)) {
        cache?.set(cacheKey, { kind: 'miss' });
      }
      throw error;
    }
  }

  public async* getChildren(identifier: ResourceIdentifier): AsyncIterableIterator<RepresentationMetadata> {
    // Children metadata is stored in the structured accessor
    yield* this.structuredDataAccessor.getChildren(identifier);
  }

  public async writeContainer(
    identifier: ResourceIdentifier,
    metadata: RepresentationMetadata,
  ): Promise<void> {
    if (this.mirrorContainersToUnstructured && this.isUnstructured(metadata)) {
      await this.unstructuredDataAccessor.writeContainer(identifier, metadata);
    }
    await this.structuredDataAccessor.writeContainer(identifier, metadata);
    this.invalidateMetadataCache(identifier);
  }

  public async writeDocument(
    identifier: ResourceIdentifier,
    data: Guarded<Readable>,
    metadata: RepresentationMetadata,
  ): Promise<void> {
    if (this.isUnstructured(metadata)) {
      await this.writeUnstructuredDocument(identifier, data, metadata);
      this.invalidateMetadataCache(identifier);
      return;
    }
    await this.writeRdfDocument(identifier, data, metadata);
    this.invalidateMetadataCache(identifier);
  }

  public async writeMetadata(identifier: ResourceIdentifier, metadata: RepresentationMetadata): Promise<void> {
    // Metadata always goes to structured storage
    await this.structuredDataAccessor.writeMetadata(identifier, metadata);
    this.invalidateMetadataCache(identifier);
  }

  public async deleteResource(identifier: ResourceIdentifier): Promise<void> {
    const metadata = await this.getMetadata(identifier);
    
    // RDF by-line resources are mirrored to local file storage so shell tools
    // can operate on real files; remove that mirror together with the index.
    if (this.isLocalMirroredRdf(identifier, metadata)) {
      await this.deleteRdfFileResourceIfPresent(identifier);
    } else if (this.isUnstructured(metadata)) {
      await this.deleteUnstructuredResourceIfPresent(identifier);
    }
    
    // Always delete from structured storage (contains metadata)
    await this.structuredDataAccessor.deleteResource(identifier);
    this.invalidateMetadataCache(identifier);
  }

  /**
   * Execute SPARQL UPDATE.
   *
   * Supported embedded deltas patch the local RDF authority file first and then
   * rebuild the structured RDF index. The structured accessor decides whether
   * unsupported shapes have an explicitly configured compatibility path.
   */
  public async executeSparqlUpdate(query: string, baseIri?: string): Promise<void> {
    if (baseIri) {
      const identifier = { path: baseIri };
      if (await this.shouldApplyLocalRdfSparqlUpdate(identifier)) {
        try {
          const writtenIdentifiers = await this.executeLocalRdfSparqlUpdate(query, identifier, new Set([identifier.path]));
          for (const writtenIdentifier of writtenIdentifiers) {
            this.invalidateMetadataCache(writtenIdentifier);
          }
          return;
        } catch (error) {
          if (!(error instanceof UnsupportedSparqlQueryError)) {
            throw error;
          }
        }
      }
    }

    const accessor = this.structuredDataAccessor as { executeSparqlUpdate?: (query: string, baseIri?: string) => Promise<void> };
    if (typeof accessor.executeSparqlUpdate !== 'function') {
      throw new Error('Structured data accessor does not support SPARQL UPDATE');
    }
    await accessor.executeSparqlUpdate(query, baseIri);
    if (baseIri) {
      const identifier = { path: baseIri };
      await this.refreshLocalRdfMirror(identifier);
      this.invalidateMetadataCache(identifier);
    }
  }

  private async shouldApplyLocalRdfSparqlUpdate(identifier: ResourceIdentifier): Promise<boolean> {
    if (this.isByLineRdfIdentifier(identifier)) {
      return true;
    }

    try {
      return this.isLocalMirroredRdf(identifier, await this.getMetadata(identifier));
    } catch (error) {
      if (NotFoundHttpError.isInstance(error)) {
        return true;
      }
      throw error;
    }
  }

  private async executeLocalRdfSparqlUpdate(
    query: string,
    identifier: ResourceIdentifier,
    localRdfAuthorityIris: ReadonlySet<string>,
  ): Promise<ResourceIdentifier[]> {
    const parsed = new SparqlParser({ baseIRI: identifier.path }).parse(query);
    const delta = this.rdfSparqlAdapter.compileUpdateDelta(parsed, this.parentContainer(identifier).path, {
      defaultGraph: identifier.path,
    });
    const writableGraphIris = this.localRdfDeltaWriteGraphIris(delta.operations, localRdfAuthorityIris);
    const graphStates = await this.loadLocalRdfDeltaGraphs(delta.operations, writableGraphIris, localRdfAuthorityIris);
    const graphQuads = new Map([...graphStates].map(([ graphIri, state ]) => [graphIri, state.quads]));
    const nextQuadsByGraph = this.applyLocalRdfDelta(graphQuads, delta.operations, writableGraphIris);
    const patches = writableGraphIris.map((graphIri): LocalRdfAuthorityPatch => {
      const previous = graphStates.get(graphIri);
      return {
        identifier: { path: graphIri },
        previousQuads: previous?.quads ?? [],
        previousExists: previous?.existed ?? false,
        nextQuads: nextQuadsByGraph.get(graphIri) ?? [],
      };
    });
    await this.writeLocalRdfAuthorityPatches(patches);
    return patches.map((patch) => patch.identifier);
  }

  private applyLocalRdfDelta(
    graphQuads: Map<string, Quad[]>,
    operations: RdfSparqlUpdateDeltaOperation[],
    writableGraphIris: string[],
  ): Map<string, Quad[]> {
    const writableGraphs = new Set(writableGraphIris);
    const byGraph = new Map<string, Map<string, Quad>>();
    for (const [ graphIri, quads ] of graphQuads) {
      byGraph.set(graphIri, new Map(quads.map((quad) => [this.quadKey(quad), quad])));
    }
    const currentQuads = (): Quad[] => [...byGraph.values()].flatMap((quads) => [...quads.values()]);
    const writableQuads = (graphIri: string): Map<string, Quad> => {
      let quads = byGraph.get(graphIri);
      if (!quads) {
        quads = new Map();
        byGraph.set(graphIri, quads);
      }
      return quads;
    };
    const deleteQuads = (quads: Quad[]): void => {
      for (const quad of quads) {
        const target = writableQuads(this.localRdfWriteGraphIri(quad.graph, writableGraphs));
        target.delete(this.quadKey(quad));
      }
    };
    const insertQuads = (quads: Quad[]): void => {
      for (const quad of quads) {
        const target = writableQuads(this.localRdfWriteGraphIri(quad.graph, writableGraphs));
        target.set(this.quadKey(quad), quad);
      }
    };

    for (const operation of operations) {
      if (operation.type === 'insert') {
        insertQuads(operation.quads);
        continue;
      }

      if (operation.type === 'delete') {
        deleteQuads(operation.quads);
        continue;
      }

      if (operation.type === 'insertDeleteWhere') {
        const rows = this.queryLocalUpdateBindings(currentQuads(), operation.query);
        deleteQuads(this.rdfSparqlAdapter.materializeDeleteWhere(operation.deletes, rows));
        insertQuads(this.rdfSparqlAdapter.materializeDeleteWhere(operation.inserts, rows));
        continue;
      }

      if (operation.type === 'insertWhere') {
        const rows = this.queryLocalUpdateBindings(currentQuads(), operation.query);
        insertQuads(this.rdfSparqlAdapter.materializeDeleteWhere(operation.inserts, rows));
        continue;
      }

      const rows = this.queryLocalUpdateBindings(currentQuads(), operation.query);
      deleteQuads(this.rdfSparqlAdapter.materializeDeleteWhere(operation.template, rows));
    }

    return new Map(writableGraphIris.map((graphIri) => [graphIri, [...(byGraph.get(graphIri)?.values() ?? [])]]));
  }

  private async loadLocalRdfDeltaGraphs(
    operations: RdfSparqlUpdateDeltaOperation[],
    writableGraphIris: readonly string[],
    localRdfAuthorityIris: ReadonlySet<string>,
  ): Promise<Map<string, LocalRdfGraphState>> {
    const graphIris = this.localRdfDeltaGraphIris(operations, writableGraphIris);
    const graphStates = new Map<string, LocalRdfGraphState>();
    for (const graphIri of graphIris) {
      const graphIdentifier = { path: graphIri };
      if (!this.isLocalRdfAuthorityIdentifier(graphIdentifier, localRdfAuthorityIris)) {
        throw new UnsupportedSparqlQueryError('Embedded local RDF update only supports by-line local RDF graph documents');
      }
      const existing = await this.readLocalRdfState(graphIdentifier);
      const graph = DataFactory.namedNode(graphIri);
      const quads = existing.text.length > 0
        ? await this.parseLocalRdf(graphIdentifier, existing.text, this.localRdfContentType(graphIdentifier))
          .then((items) => items.map((quad) => this.toGraphQuad(quad, graph)))
        : [];
      graphStates.set(graphIri, { quads, existed: existing.existed });
    }
    return graphStates;
  }

  private localRdfDeltaGraphIris(
    operations: RdfSparqlUpdateDeltaOperation[],
    writableGraphIris: readonly string[],
  ): string[] {
    const graphIris = new Set<string>(writableGraphIris);
    for (const operation of operations) {
      const graphTerms = operation.type === 'deleteWhere'
        ? [
            ...operation.template.map((item) => item.graph),
            ...this.queryGraphTerms(operation.query),
          ]
        : operation.type === 'insertDeleteWhere'
        ? [
            ...operation.deletes.map((item) => item.graph),
            ...operation.inserts.map((item) => item.graph),
            ...this.queryGraphTerms(operation.query),
          ]
        : operation.type === 'insertWhere'
        ? [
            ...operation.inserts.map((item) => item.graph),
            ...this.queryGraphTerms(operation.query),
          ]
        : operation.quads.map((quad) => quad.graph);
      for (const graph of graphTerms) {
        this.addNamedGraphIris(graph, graphIris);
      }
    }
    return [...graphIris];
  }

  private localRdfDeltaWriteGraphIris(
    operations: RdfSparqlUpdateDeltaOperation[],
    localRdfAuthorityIris: ReadonlySet<string>,
  ): string[] {
    const graphIris = new Set<string>();
    for (const operation of operations) {
      if (operation.type === 'deleteWhere') {
        this.addWritableTemplateGraphIris(operation.template.map((item) => item.graph), operation.query, graphIris, localRdfAuthorityIris);
        continue;
      }
      if (operation.type === 'insertDeleteWhere') {
        this.addWritableTemplateGraphIris([
          ...operation.deletes.map((item) => item.graph),
          ...operation.inserts.map((item) => item.graph),
        ], operation.query, graphIris, localRdfAuthorityIris);
        continue;
      }
      if (operation.type === 'insertWhere') {
        this.addWritableTemplateGraphIris(operation.inserts.map((item) => item.graph), operation.query, graphIris, localRdfAuthorityIris);
        continue;
      }
      const graphTerms = operation.quads.map((quad) => quad.graph);
      for (const graph of graphTerms) {
        this.addWritableNamedGraphIri(graph, graphIris, localRdfAuthorityIris);
      }
    }
    if (graphIris.size === 0) {
      throw new UnsupportedSparqlQueryError('Embedded local RDF update requires explicit local RDF graph write targets');
    }
    return [...graphIris];
  }

  private addWritableTemplateGraphIris(
    graphs: RdfQueryTermPattern[],
    query: RdfQuery,
    graphIris: Set<string>,
    localRdfAuthorityIris: ReadonlySet<string>,
  ): void {
    for (const graph of graphs) {
      if (this.isQueryVariable(graph)) {
        this.addWritableGraphVariableIris(query, graph.variable, graphIris, localRdfAuthorityIris);
        continue;
      }
      this.addWritableNamedGraphIri(graph, graphIris, localRdfAuthorityIris);
    }
  }

  private addWritableGraphVariableIris(
    query: RdfQuery,
    variable: string,
    graphIris: Set<string>,
    localRdfAuthorityIris: ReadonlySet<string>,
  ): void {
    const values = new Set<string>();
    this.collectGraphVariableFilterIris(query, variable, values);
    if (values.size === 0) {
      throw new UnsupportedSparqlQueryError('Embedded local RDF update only supports finite GRAPH variable write targets');
    }
    for (const value of values) {
      this.addWritableNamedGraphIri(DataFactory.namedNode(value) as unknown as Term, graphIris, localRdfAuthorityIris);
    }
  }

  private localRdfWriteGraphIri(graph: Term, writableGraphs: Set<string>): string {
    if (graph.termType !== 'NamedNode' || !writableGraphs.has(graph.value)) {
      throw new UnsupportedSparqlQueryError('Embedded local RDF update can only write declared local RDF graph documents');
    }
    return graph.value;
  }

  private queryLocalUpdateBindings(
    quads: Quad[],
    query: RdfQuery,
  ): RdfBindingRow[] {
    const index = new RdfQuadIndex({ path: ':memory:' });
    index.open();
    try {
      const engine = new SolidRdfEngine({ index });
      engine.put(quads);
      return engine.query(query).bindings;
    } finally {
      index.close();
    }
  }

  private queryGraphTerms(query: RdfQuery): RdfQueryTermPattern[] {
    const graphTerms: RdfQueryTermPattern[] = [];
    const graphVariables = new Set<string>();
    this.collectQueryGraphTerms(query, graphTerms, graphVariables);
    this.collectGraphVariableFilterTerms(query, graphVariables, graphTerms);
    return graphTerms;
  }

  private collectQueryGraphTerms(
    query: RdfQuery | {
      patterns: RdfQueryPattern[];
      values?: RdfValuesBindingSource[];
      optional?: RdfQuery['optional'];
      unions?: RdfQuery['unions'];
      minus?: RdfQuery['minus'];
      exists?: RdfQuery['exists'];
    },
    graphTerms: RdfQueryTermPattern[],
    graphVariables: Set<string>,
  ): void {
    for (const pattern of query.patterns) {
      if (!pattern.graph) {
        continue;
      }
      graphTerms.push(pattern.graph);
      if (this.isQueryVariable(pattern.graph)) {
        graphVariables.add(pattern.graph.variable);
      }
    }
    for (const optional of query.optional ?? []) {
      this.collectQueryGraphTerms(Array.isArray(optional) ? { patterns: optional } : optional, graphTerms, graphVariables);
    }
    for (const union of query.unions ?? []) {
      for (const branch of union.branches) {
        this.collectQueryGraphTerms(branch, graphTerms, graphVariables);
      }
    }
    for (const minus of query.minus ?? []) {
      this.collectQueryGraphTerms(minus, graphTerms, graphVariables);
    }
    for (const exists of query.exists ?? []) {
      this.collectQueryGraphTerms(exists, graphTerms, graphVariables);
    }
  }

  private collectGraphVariableFilterTerms(
    query: RdfQuery | {
      values?: RdfValuesBindingSource[];
      filters?: RdfQuery['filters'];
      optional?: RdfQuery['optional'];
      unions?: RdfQuery['unions'];
      minus?: RdfQuery['minus'];
      exists?: RdfQuery['exists'];
    },
    graphVariables: Set<string>,
    graphTerms: RdfQueryTermPattern[],
  ): void {
    for (const filter of query.filters ?? []) {
      if (!graphVariables.has(filter.variable)) {
        continue;
      }
      if (filter.value && this.isRdfTerm(filter.value)) {
        graphTerms.push(filter.value);
      }
      for (const value of filter.values ?? []) {
        if (this.isRdfTerm(value)) {
          graphTerms.push(value);
        }
      }
    }
    this.collectGraphVariableValueTerms(query.values ?? [], graphVariables, graphTerms);
    for (const optional of query.optional ?? []) {
      if (!Array.isArray(optional)) {
        this.collectGraphVariableFilterTerms(optional, graphVariables, graphTerms);
      }
    }
    for (const union of query.unions ?? []) {
      for (const branch of union.branches) {
        this.collectGraphVariableFilterTerms(branch, graphVariables, graphTerms);
      }
    }
    for (const minus of query.minus ?? []) {
      this.collectGraphVariableFilterTerms(minus, graphVariables, graphTerms);
    }
    for (const exists of query.exists ?? []) {
      this.collectGraphVariableFilterTerms(exists, graphVariables, graphTerms);
    }
  }

  private collectGraphVariableFilterIris(
    query: RdfQuery | {
      values?: RdfValuesBindingSource[];
      filters?: RdfQuery['filters'];
      optional?: RdfQuery['optional'];
      unions?: RdfQuery['unions'];
      minus?: RdfQuery['minus'];
      exists?: RdfQuery['exists'];
    },
    variable: string,
    values: Set<string>,
  ): void {
    for (const filter of query.filters ?? []) {
      if (filter.variable !== variable) {
        continue;
      }
      if ((filter.operator === '$eq' || filter.operator === '$sameTerm') && filter.value && this.isRdfTerm(filter.value)) {
        this.addGraphFilterValueIri(filter.value, values);
      }
      if (filter.operator === '$in') {
        for (const value of filter.values ?? []) {
          if (this.isRdfTerm(value)) {
            this.addGraphFilterValueIri(value, values);
          }
        }
      }
    }
    this.collectGraphVariableValueIris(query.values ?? [], variable, values);
    for (const optional of query.optional ?? []) {
      if (!Array.isArray(optional)) {
        this.collectGraphVariableFilterIris(optional, variable, values);
      }
    }
    for (const union of query.unions ?? []) {
      for (const branch of union.branches) {
        this.collectGraphVariableFilterIris(branch, variable, values);
      }
    }
    for (const minus of query.minus ?? []) {
      this.collectGraphVariableFilterIris(minus, variable, values);
    }
    for (const exists of query.exists ?? []) {
      this.collectGraphVariableFilterIris(exists, variable, values);
    }
  }

  private collectGraphVariableValueTerms(
    sources: readonly RdfValuesBindingSource[],
    graphVariables: Set<string>,
    graphTerms: RdfQueryTermPattern[],
  ): void {
    for (const source of sources) {
      for (const variable of source.variables) {
        if (!graphVariables.has(variable)) {
          continue;
        }
        for (const row of source.rows) {
          const value = row[variable];
          if (value) {
            graphTerms.push(value);
          }
        }
      }
    }
  }

  private collectGraphVariableValueIris(
    sources: readonly RdfValuesBindingSource[],
    variable: string,
    values: Set<string>,
  ): void {
    for (const source of sources) {
      if (!source.variables.includes(variable)) {
        continue;
      }
      for (const row of source.rows) {
        const value = row[variable];
        if (value) {
          this.addGraphFilterValueIri(value, values);
        }
      }
    }
  }

  private addGraphFilterValueIri(value: Term, values: Set<string>): void {
    if (value.termType !== 'NamedNode') {
      throw new UnsupportedSparqlQueryError('Embedded local RDF update GRAPH variable write targets must be named graph documents');
    }
    values.add(value.value);
  }

  private addNamedGraphIris(graph: RdfQueryTermPattern | Term, graphIris: Set<string>): void {
    if (this.isRdfTerm(graph)) {
      if (graph.termType !== 'NamedNode') {
        throw new UnsupportedSparqlQueryError('Embedded local RDF update only supports named graph documents');
      }
      graphIris.add(graph.value);
      return;
    }
    const values = (graph as { $in?: unknown }).$in;
    if (Array.isArray(values) && values.every((value) => this.isRdfTerm(value))) {
      for (const value of values) {
        if (value.termType !== 'NamedNode') {
          throw new UnsupportedSparqlQueryError('Embedded local RDF update only supports named graph documents');
        }
        graphIris.add(value.value);
      }
      return;
    }
    if (this.isQueryVariable(graph)) {
      return;
    }
    throw new UnsupportedSparqlQueryError('Embedded local RDF update only supports explicit local RDF graph documents');
  }

  private addWritableNamedGraphIri(
    graph: RdfQueryTermPattern | Term,
    graphIris: Set<string>,
    localRdfAuthorityIris: ReadonlySet<string>,
  ): void {
    if (!this.isRdfTerm(graph) || graph.termType !== 'NamedNode') {
      throw new UnsupportedSparqlQueryError('Embedded local RDF update only supports explicit local RDF graph write targets');
    }
    if (!this.isLocalRdfAuthorityIdentifier({ path: graph.value }, localRdfAuthorityIris)) {
      throw new UnsupportedSparqlQueryError('Embedded local RDF update only supports by-line local RDF graph write targets');
    }
    graphIris.add(graph.value);
  }

  private isLocalRdfAuthorityIdentifier(
    identifier: ResourceIdentifier,
    localRdfAuthorityIris: ReadonlySet<string>,
  ): boolean {
    return this.isByLineRdfIdentifier(identifier) || localRdfAuthorityIris.has(identifier.path);
  }

  private isQueryVariable(value: unknown): value is { variable: string } {
    return Boolean(value && typeof value === 'object' && 'variable' in value);
  }

  private isRdfTerm(value: unknown): value is Term {
    return Boolean(value && typeof value === 'object' && 'termType' in value);
  }

  private async readLocalRdfState(identifier: ResourceIdentifier): Promise<{ text: string; existed: boolean }> {
    try {
      return {
        text: await this.readStreamText(await this.rdfFileDataAccessor.getData(identifier)),
        existed: true,
      };
    } catch (error) {
      if (NotFoundHttpError.isInstance(error)) {
        await this.refreshLocalRdfMirror(identifier);
        try {
          return {
            text: await this.readStreamText(await this.rdfFileDataAccessor.getData(identifier)),
            existed: true,
          };
        } catch (retryError) {
          if (NotFoundHttpError.isInstance(retryError)) {
            return { text: '', existed: false };
          }
          throw retryError;
        }
      }
      throw error;
    }
  }

  private async writeLocalRdfAuthority(identifier: ResourceIdentifier, quads: Quad[]): Promise<void> {
    await this.ensureRdfFileParentContainers(identifier);
    await this.rdfFileDataAccessor.writeDocument(
      identifier,
      guardStream(Readable.from([ await this.serializeQuadsForLocalFile(identifier, quads) ])),
      this.createLocalRdfMetadata(identifier, new RepresentationMetadata(identifier)),
    );
  }

  private async writeLocalRdfAuthorityPatches(patches: LocalRdfAuthorityPatch[]): Promise<void> {
    const applied: LocalRdfAuthorityPatch[] = [];
    try {
      for (const patch of patches) {
        let localAuthorityWritten = false;
        try {
          const authorityQuads = patch.nextQuads.map((quad) => this.toDefaultGraphQuad(quad));
          await this.writeLocalRdfAuthority(patch.identifier, authorityQuads);
          localAuthorityWritten = true;
          await this.writeStructuredRdfIndex(patch.identifier, authorityQuads, new RepresentationMetadata(patch.identifier));
          applied.push(patch);
        } catch (error) {
          if (localAuthorityWritten) {
            applied.push(patch);
          }
          throw error;
        }
      }
    } catch (error) {
      await this.rollbackLocalRdfAuthorityPatches(applied);
      throw error;
    }
  }

  private async rollbackLocalRdfAuthorityPatches(patches: LocalRdfAuthorityPatch[]): Promise<void> {
    const failures: string[] = [];
    for (const patch of patches.slice().reverse()) {
      try {
        if (patch.previousExists) {
          const authorityQuads = patch.previousQuads.map((quad) => this.toDefaultGraphQuad(quad));
          await this.writeLocalRdfAuthority(patch.identifier, authorityQuads);
          await this.writeStructuredRdfIndex(patch.identifier, authorityQuads, new RepresentationMetadata(patch.identifier));
        } else {
          await this.deleteRdfFileResourceIfPresent(patch.identifier);
          await this.deleteLocalRdfIndex(patch.identifier);
        }
        this.invalidateMetadataCache(patch.identifier);
      } catch (rollbackError) {
        failures.push(`${patch.identifier.path}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
      }
    }
    if (failures.length > 0) {
      this.logger.warn(`Failed to fully roll back local RDF authority patch: ${failures.join('; ')}`);
    }
  }

  private toDefaultGraphQuad(quad: Quad): Quad {
    return DataFactory.quad(quad.subject, quad.predicate, quad.object);
  }

  private toGraphQuad(quad: Quad, graph: Term): Quad {
    return DataFactory.quad(quad.subject, quad.predicate, quad.object, graph as any) as Quad;
  }

  private quadKey(quad: Quad): string {
    return [quad.graph, quad.subject, quad.predicate, quad.object]
      .map((term) => termToId(term as any))
      .join('\u001f');
  }

  /**
   * Rebuild the structured RDF index from an already-written local RDF file.
   *
   * SolidFS uses this after tools edit `.ttl`/`.jsonld` files directly. The
   * local file remains the content authority; the structured accessor is only
   * refreshed as query/index state.
   */
  public async syncLocalRdfDocument(
    identifier: ResourceIdentifier,
    data?: Guarded<Readable>,
    contentType?: string,
    options?: LocalRdfSyncOptions,
  ): Promise<void> {
    if (!this.isRdfDocumentIdentifier(identifier)) {
      throw new Error(`Cannot sync non RDF document into RDF index: ${identifier.path}`);
    }

    const source = data ?? await this.rdfFileDataAccessor.getData(identifier);
    const localContentType = contentType ?? this.localRdfContentType(identifier);
    const text = await this.readStreamText(source);
    if (data) {
      await this.ensureRdfFileParentContainers(identifier);
      await this.rdfFileDataAccessor.writeDocument(
        identifier,
        guardStream(Readable.from([ text ])),
        this.createLocalRdfMetadata(identifier, new RepresentationMetadata(identifier)),
      );
    }
    const quads = await this.parseLocalRdf(identifier, text, localContentType);
    await this.writeStructuredRdfIndex(identifier, quads, new RepresentationMetadata(identifier), {
      ...options,
      contentType: localContentType,
    });
    this.invalidateMetadataCache(identifier);
  }

  public async deleteLocalRdfIndex(identifier: ResourceIdentifier): Promise<void> {
    try {
      const sourceScopedAccessor = this.sourceScopedStructuredAccessor();
      if (sourceScopedAccessor) {
        await sourceScopedAccessor.deleteRdfSourceDocument(identifier);
      } else {
        await this.structuredDataAccessor.deleteResource(identifier);
      }
      this.invalidateMetadataCache(identifier);
    } catch (error) {
      if (!NotFoundHttpError.isInstance(error)) {
        throw error;
      }
    }
  }

  private async writeRdfDocument(
    identifier: ResourceIdentifier,
    data: Guarded<Readable>,
    metadata: RepresentationMetadata,
  ): Promise<void> {
    const quads = await arrayifyStream<Quad>(data);
    const structuredMetadata = new RepresentationMetadata(metadata);
    addResourceMetadata(structuredMetadata, false);
    updateModifiedDate(structuredMetadata);
    await this.ensureRdfFileParentContainers(identifier);

    await this.rdfFileDataAccessor.writeDocument(
      identifier,
      guardStream(Readable.from([ await this.serializeQuadsForLocalFile(identifier, quads) ])),
      this.createLocalRdfMetadata(identifier, metadata),
    );

    try {
      await this.writeStructuredRdfIndex(identifier, quads, structuredMetadata);
    } catch (error) {
      await this.deleteRdfFileResourceIfPresent(identifier);
      throw error;
    }
  }

  private async writeStructuredRdfIndex(
    identifier: ResourceIdentifier,
    quads: Quad[],
    metadata: RepresentationMetadata,
    options: LocalRdfSyncOptions & { contentType?: string } = {},
  ): Promise<void> {
    const structuredMetadata = new RepresentationMetadata(metadata);
    addResourceMetadata(structuredMetadata, false);
    updateModifiedDate(structuredMetadata);
    const sourceScopedAccessor = this.sourceScopedStructuredAccessor();
    if (sourceScopedAccessor) {
      await sourceScopedAccessor.writeRdfSourceDocument(
        identifier,
        quads,
        structuredMetadata,
        this.rdfSourceInput(identifier, options),
      );
      return;
    }

    await this.structuredDataAccessor.writeDocument(identifier, guardStream(Readable.from(quads)), structuredMetadata);
  }

  private async refreshLocalRdfMirror(identifier: ResourceIdentifier): Promise<void> {
    let metadata: RepresentationMetadata;
    let quads: Quad[];
    try {
      metadata = await this.structuredDataAccessor.getMetadata(identifier);
      if (!this.isLocalMirroredRdf(identifier, metadata)) {
        return;
      }
      quads = await arrayifyStream<Quad>(await this.structuredDataAccessor.getData(identifier));
    } catch (error) {
      if (NotFoundHttpError.isInstance(error)) {
        await this.deleteRdfFileResourceIfPresent(identifier);
        return;
      }
      throw error;
    }

    await this.ensureRdfFileParentContainers(identifier);
    await this.rdfFileDataAccessor.writeDocument(
      identifier,
      guardStream(Readable.from([ await this.serializeQuadsForLocalFile(identifier, quads) ])),
      this.createLocalRdfMetadata(identifier, metadata),
    );
  }

  private async getLocalRdfMetadata(
    identifier: ResourceIdentifier,
    sourceMetadata: RepresentationMetadata,
  ): Promise<RepresentationMetadata> {
    try {
      return await this.getExistingLocalRdfMetadata(identifier);
    } catch (error) {
      if (!NotFoundHttpError.isInstance(error)) {
        throw error;
      }
      return this.createLocalRdfMetadata(identifier, sourceMetadata);
    }
  }

  private async getExistingLocalRdfMetadata(identifier: ResourceIdentifier): Promise<RepresentationMetadata> {
    try {
      const metadata = await this.rdfFileDataAccessor.getMetadata(identifier);
      metadata.contentType = this.localRdfContentType(identifier);
      return metadata;
    } catch (error) {
      if (NotFoundHttpError.isInstance(error)) {
        throw error;
      }
      this.logger.warn(`Ignoring unreadable local RDF metadata for ${identifier.path}: ${error instanceof Error ? error.message : String(error)}`);
      return this.createLocalRdfMetadata(identifier, new RepresentationMetadata(identifier));
    }
  }

  private createLocalRdfMetadata(
    identifier: ResourceIdentifier,
    metadata: RepresentationMetadata,
  ): RepresentationMetadata {
    const localMetadata = new RepresentationMetadata(metadata);
    const graphScopedQuads = localMetadata.quads()
      .filter((quad) => quad.graph.termType !== 'DefaultGraph');
    localMetadata.removeQuads(graphScopedQuads);
    localMetadata.contentType = this.localRdfContentType(identifier);
    return localMetadata;
  }

  private localRdfContentType(identifier: ResourceIdentifier): string {
    return rdfContentTypeForPath(identifier.path) ?? 'text/turtle';
  }

  private sourceScopedStructuredAccessor(): SourceScopedStructuredRdfAccessor | undefined {
    const accessor = this.structuredDataAccessor as Partial<SourceScopedStructuredRdfAccessor>;
    if (
      typeof accessor.writeRdfSourceDocument === 'function'
      && typeof accessor.deleteRdfSourceDocument === 'function'
    ) {
      return accessor as SourceScopedStructuredRdfAccessor;
    }
    return undefined;
  }

  private rdfSourceInput(
    identifier: ResourceIdentifier,
    options: LocalRdfSyncOptions & { contentType?: string },
  ): RdfSourceInput {
    const workspace = options.workspace ?? this.parentContainer(identifier).path;
    return {
      source: options.source ?? identifier.path,
      workspace,
      localPath: options.localPath ?? this.relativePathFromWorkspace(identifier.path, workspace),
      contentType: options.contentType ?? this.localRdfContentType(identifier),
      sourceVersion: options.sourceVersion,
    };
  }

  private relativePathFromWorkspace(identifierPath: string, workspaceValue: string): string | undefined {
    try {
      const resource = new URL(identifierPath);
      const workspace = new URL(workspaceValue.endsWith('/') ? workspaceValue : `${workspaceValue}/`);
      if (resource.origin !== workspace.origin || !resource.pathname.startsWith(workspace.pathname)) {
        return undefined;
      }
      return decodeURIComponent(resource.pathname.slice(workspace.pathname.length));
    } catch {
      return undefined;
    }
  }

  private isByLineRdfIdentifier(identifier: ResourceIdentifier): boolean {
    return isLineAddressableRdfPath(identifier.path);
  }

  private isRdfDocumentIdentifier(identifier: ResourceIdentifier): boolean {
    return isRdfDocumentPath(identifier.path);
  }

  private isLocalMirroredRdf(
    identifier: ResourceIdentifier,
    metadata: RepresentationMetadata,
  ): boolean {
    return metadata.contentType === INTERNAL_QUADS || this.isRdfDocumentIdentifier(identifier);
  }

  private async serializeQuadsForLocalFile(identifier: ResourceIdentifier, quads: Quad[]): Promise<string> {
    if (this.localRdfContentType(identifier) === 'application/ld+json') {
      const nquads = await this.serializeNQuads(quads);
      const document = await jsonld.fromRDF(nquads, { format: 'application/n-quads' });
      return `${JSON.stringify(document, null, 2)}\n`;
    }

    if (this.localRdfContentType(identifier) === 'application/rdf+xml') {
      return serializeRdfXml(quads);
    }

    const writer = new Writer({ format: this.localRdfContentType(identifier) });
    return writer.quadsToString(quads);
  }

  private async serializeNQuads(quads: Quad[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const writer = new Writer({ format: 'application/n-quads' });
      writer.addQuads(quads);
      writer.end((error, result) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(result);
      });
    });
  }

  private async parseLocalRdf(
    identifier: ResourceIdentifier,
    text: string,
    contentType: string,
  ): Promise<Quad[]> {
    if (contentType === 'application/ld+json') {
      const nquads = await jsonld.toRDF(JSON.parse(text), {
        base: identifier.path,
        format: 'application/n-quads',
      }) as string;
      return new Parser({ format: 'application/n-quads', baseIRI: identifier.path }).parse(nquads);
    }

    if (contentType === 'application/rdf+xml') {
      return arrayifyStream<Quad>(rdfParser.parse(Readable.from([ text ]), {
        contentType,
        baseIRI: identifier.path,
      }) as any);
    }

    return new Parser({ format: contentType, baseIRI: identifier.path }).parse(text);
  }

  private async readStreamText(data: Guarded<Readable>): Promise<string> {
    const chunks = await arrayifyStream(data as any);
    return chunks
      .map((chunk: Buffer | Uint8Array | string) => typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
      .join('');
  }

  /**
   * Write unstructured document: store data in unstructured accessor,
   * then save metadata in structured accessor.
   */
  private async writeUnstructuredDocument(
    identifier: ResourceIdentifier,
    data: Guarded<Readable>,
    metadata: RepresentationMetadata,
  ): Promise<void> {
    await this.ensureUnstructuredParentContainers(identifier);

    // Write the actual data to unstructured storage
    await this.unstructuredDataAccessor.writeDocument(identifier, data, metadata);
    
    let updatedMetadata: RepresentationMetadata;
    if (typeof metadata.contentLength === 'number') {
      updatedMetadata = new RepresentationMetadata(metadata);
      updatedMetadata.add(
        POSIX.terms.size,
        toLiteral(metadata.contentLength, XSD.terms.integer),
        SOLID_META.terms.ResponseMetadata,
      );
    } else {
      updatedMetadata = await this.unstructuredDataAccessor.getMetadata(identifier);

      const removing: Quad[] = [];
      for (const quad of updatedMetadata.quads()) {
        if (!/^http/.test(quad.predicate.value)) {
          removing.push(quad);
        }
      }
      updatedMetadata.removeQuads(removing);
    }
    
    // Save metadata to structured storage
    try {
      await this.structuredDataAccessor.writeMetadata(identifier, updatedMetadata);
    } catch (error) {
      this.logger.error(`Error writing metadata for ${identifier.path}: ${error}`);
      // Rollback: delete the unstructured data
      await this.unstructuredDataAccessor.deleteResource(identifier);
      throw error;
    }
  }

  private async deleteUnstructuredResourceIfPresent(identifier: ResourceIdentifier): Promise<void> {
    try {
      await this.unstructuredDataAccessor.deleteResource(identifier);
    } catch (error: any) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR' && !NotFoundHttpError.isInstance(error)) {
        throw error;
      }
    }
  }

  private async deleteRdfFileResourceIfPresent(identifier: ResourceIdentifier): Promise<void> {
    try {
      await this.rdfFileDataAccessor.deleteResource(identifier);
    } catch (error: any) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR' && !NotFoundHttpError.isInstance(error)) {
        throw error;
      }
    }
  }

  private async ensureUnstructuredParentContainers(identifier: ResourceIdentifier): Promise<void> {
    await this.ensureParentContainers(identifier, this.unstructuredDataAccessor);
  }

  private async ensureRdfFileParentContainers(identifier: ResourceIdentifier): Promise<void> {
    await this.ensureParentContainers(identifier, this.rdfFileDataAccessor);
  }

  private async ensureParentContainers(identifier: ResourceIdentifier, accessor: DataAccessor): Promise<void> {
    const containers: ResourceIdentifier[] = [];
    let current = this.parentContainer(identifier);

    while (!this.sameIdentifier(current, identifier)) {
      containers.push(current);
      const next = this.parentContainer(current);
      if (this.sameIdentifier(next, current)) {
        break;
      }
      current = next;
    }

    for (const container of containers.reverse()) {
      await this.writeContainerIfMissing(accessor, container);
    }
  }

  private async writeContainerIfMissing(accessor: DataAccessor, identifier: ResourceIdentifier): Promise<void> {
    try {
      await accessor.getMetadata(identifier);
      return;
    } catch (error) {
      if (!NotFoundHttpError.isInstance(error)) {
        throw error;
      }
    }

    await accessor.writeContainer(identifier, new RepresentationMetadata(identifier));
  }

  private sameIdentifier(left: ResourceIdentifier, right: ResourceIdentifier): boolean {
    return left.path === right.path;
  }

  private parentContainer(identifier: ResourceIdentifier): ResourceIdentifier {
    try {
      const url = new URL(identifier.path);
      if (url.pathname === '/' || url.pathname === '') {
        return { path: url.href.endsWith('/') ? url.href : `${url.href}/` };
      }
      const segments = url.pathname.replace(/\/+$/u, '').split('/');
      segments.pop();
      url.pathname = `${segments.join('/') || '/'}`.replace(/\/?$/u, '/');
      url.search = '';
      url.hash = '';
      return { path: url.href };
    } catch {
      const trimmed = identifier.path.replace(/\/+$/u, '');
      const slashIndex = trimmed.lastIndexOf('/');
      if (slashIndex < 0) {
        return identifier;
      }
      return { path: `${trimmed.slice(0, slashIndex + 1)}` };
    }
  }

  private invalidateMetadataCache(identifier: ResourceIdentifier): void {
    const cache = metadataRequestContext.getStore()?.metadataCache;
    if (!cache) {
      return;
    }

    const exact = identifier.path;
    const trimmed = exact.endsWith('/') ? exact.replace(/\/+$/u, '') : exact;
    const withSlash = exact.endsWith('/') ? exact : `${exact}/`;
    cache.delete(exact);
    cache.delete(trimmed);
    cache.delete(withSlash);
  }
}
