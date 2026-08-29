import { Readable } from 'node:stream';
import arrayifyStream from 'arrayify-stream';
import { getLoggerFor } from 'global-logger-factory';
import { DataFactory } from 'n3';
import type { NamedNode, Quad } from '@rdfjs/types';
import {
  addResourceMetadata,
  CONTENT_TYPE_TERM,
  ConflictHttpError,
  DataAccessor,
  guardStream,
  IdentifierStrategy,
  INTERNAL_QUADS,
  isContainerIdentifier,
  LDP,
  NotFoundHttpError,
  NotImplementedHttpError,
  RepresentationMetadata,
  UnsupportedMediaTypeHttpError,
  updateModifiedDate,
  type Guarded,
  type Representation,
  type ResourceIdentifier,
} from '@solid/community-server';
import {
  applyRdfAccessScope,
  type RdfAccessScope,
} from '../rdf/RdfAccessScope';
import {
  NativeSparqlExecutionError,
  UnsupportedSparqlQueryError,
} from '../rdf/RdfSparqlBoundary';
import {
  DisabledSparqlFeatureError as AdapterDisabledSparqlFeatureError,
  RdfSparqlAdapter,
  UnsupportedSparqlQueryError as AdapterUnsupportedSparqlQueryError,
} from '../rdf/RdfSparqlAdapter';
import type {
  RdfEngineLike,
  RdfNativeSparqlAccessScope,
  RdfPreparedUpdateDelta,
  RdfPreparedUpdateGraphDelta,
  RdfSourceInput,
  RdfTextChunkInput,
  RdfTextSourceInput,
  RdfVectorChunkInput,
  RdfVectorSourceInput,
} from '../rdf/types';
import type { Quint } from '../quint/types';

const { defaultGraph, namedNode, quad } = DataFactory;
export const PREPARED_UPDATE_MEDIA_TYPE = 'application/vnd.xpod.rdf-prepared-delta+json;version=1';

interface PreparedTermJson {
  type: 'uri' | 'literal' | 'bnode';
  value: string;
  datatype?: string;
  'xml:lang'?: string;
}

interface PreparedQuadJson {
  subject: PreparedTermJson;
  predicate: PreparedTermJson;
  object: PreparedTermJson;
  graph: PreparedTermJson;
}

function preparedTerm(value: unknown): ReturnType<typeof DataFactory.namedNode> | ReturnType<typeof DataFactory.literal> {
  if (!value || typeof value !== 'object') {
    throw new NativeSparqlExecutionError('Native prepared update contains an invalid RDF term');
  }
  const term = value as Partial<PreparedTermJson>;
  if (typeof term.value !== 'string') {
    throw new NativeSparqlExecutionError('Native prepared update contains an invalid RDF term value');
  }
  if (term.type === 'uri') {
    return namedNode(term.value);
  }
  if (term.type === 'literal') {
    if (typeof term['xml:lang'] === 'string' && term['xml:lang']) {
      return DataFactory.literal(term.value, term['xml:lang']);
    }
    if (typeof term.datatype === 'string' && term.datatype) {
      return DataFactory.literal(term.value, namedNode(term.datatype));
    }
    return DataFactory.literal(term.value);
  }
  throw new UnsupportedSparqlQueryError('Native prepared update cannot stably replay blank-node terms');
}

function preparedQuad(value: unknown): Quad {
  if (!value || typeof value !== 'object') {
    throw new NativeSparqlExecutionError('Native prepared update contains an invalid RDF quad');
  }
  const candidate = value as Partial<PreparedQuadJson>;
  const subject = preparedTerm(candidate.subject);
  const predicate = preparedTerm(candidate.predicate);
  const object = preparedTerm(candidate.object);
  const graph = preparedTerm(candidate.graph);
  if (subject.termType !== 'NamedNode' || predicate.termType !== 'NamedNode' || graph.termType !== 'NamedNode') {
    throw new UnsupportedSparqlQueryError('Native prepared update v1 requires named subject, predicate, and graph terms');
  }
  return DataFactory.quad(subject, predicate, object, graph);
}

export function parsePreparedUpdateDelta(body: string): RdfPreparedUpdateDelta {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new NativeSparqlExecutionError('Native prepared update returned invalid JSON');
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new NativeSparqlExecutionError('Native prepared update returned an invalid envelope');
  }
  const envelope = parsed as { version?: unknown; graphs?: unknown };
  if (envelope.version !== 1 || !Array.isArray(envelope.graphs)) {
    throw new NativeSparqlExecutionError('Native prepared update requires version 1 graph deltas');
  }
  const graphs = envelope.graphs.map((value): RdfPreparedUpdateGraphDelta => {
    if (!value || typeof value !== 'object') {
      throw new NativeSparqlExecutionError('Native prepared update contains an invalid graph delta');
    }
    const graph = value as { graphIri?: unknown; sourceUri?: unknown; deletes?: unknown; inserts?: unknown };
    if (
      typeof graph.graphIri !== 'string' ||
      typeof graph.sourceUri !== 'string' ||
      !Array.isArray(graph.deletes) ||
      !Array.isArray(graph.inserts)
    ) {
      throw new NativeSparqlExecutionError('Native prepared update contains incomplete graph provenance');
    }
    return {
      graphIri: graph.graphIri,
      sourceUri: graph.sourceUri,
      deletes: graph.deletes.map(preparedQuad),
      inserts: graph.inserts.map(preparedQuad),
    };
  });
  return { version: 1, graphs };
}

function graphDeltaFor(
  deltas: Map<string, RdfPreparedUpdateGraphDelta>,
  quad: Quad,
): RdfPreparedUpdateGraphDelta {
  if (quad.graph.termType !== 'NamedNode') {
    throw new UnsupportedSparqlQueryError(
      'SPARQL UPDATE prepared delta requires a named writable graph',
      {
        code: 'rdf.sparql.update_authority_required',
        capability: 'sparql.update.authority',
      },
    );
  }
  const graphIri = quad.graph.value;
  let delta = deltas.get(graphIri);
  if (!delta) {
    delta = {
      graphIri,
      sourceUri: graphIri,
      deletes: [],
      inserts: [],
    };
    deltas.set(graphIri, delta);
  }
  return delta;
}

function normalizeAdapterError(error: unknown): Error {
  if (error instanceof AdapterDisabledSparqlFeatureError) {
    return new UnsupportedSparqlQueryError(error.message);
  }
  if (error instanceof AdapterUnsupportedSparqlQueryError) {
    return new UnsupportedSparqlQueryError(error.message, {
      code: error.code,
      capability: error.capability,
      hint: error.hint,
      correction: error.correction,
    });
  }
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Structured RDF DataAccessor backed directly by SolidRdfEngine.
 *
 * This is the server-owned Pod storage path. It writes resource graphs and
 * metadata graphs into the term-id RDF index without routing simple CSS LDP
 * operations through Comunica.
 */
export class SolidRdfDataAccessor implements DataAccessor {
  protected readonly logger = getLoggerFor(this);
  private readonly sparqlAdapter = new RdfSparqlAdapter();
  private initialized = false;
  private initializing: Promise<void> | null = null;

  public constructor(
    private readonly rdfEngine: RdfEngineLike,
    private readonly identifierStrategy: IdentifierStrategy,
  ) {}

  public async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    this.initializing ??= Promise.resolve()
      .then(async () => {
        await this.rdfEngine.open();
        await this.rdfEngine.refreshDerivedIndexes();
        this.initialized = true;
      })
      .finally(() => {
        this.initializing = null;
      });

    await this.initializing;
  }

  public async finalize(): Promise<void> {
    if (this.initializing) {
      await this.initializing.catch(() => {});
    }
    if (this.initialized) {
      await this.rdfEngine.close();
      this.initialized = false;
    }
  }

  public async canHandle(representation: Representation): Promise<void> {
    if (representation.binary || representation.metadata.contentType !== INTERNAL_QUADS) {
      throw new UnsupportedMediaTypeHttpError('Only Quad data is supported.');
    }
  }

  public async getData(identifier: ResourceIdentifier): Promise<Guarded<Readable>> {
    await this.initialize();
    const quads = await this.scanGraph(namedNode(identifier.path));
    return guardStream(Readable.from(quads));
  }

  public async getMetadata(identifier: ResourceIdentifier): Promise<RepresentationMetadata> {
    await this.initialize();
    const name = namedNode(identifier.path);
    const quads = await this.scanGraph(this.getMetadataNode(name));

    if (quads.length === 0) {
      throw new NotFoundHttpError();
    }

    const metadata = new RepresentationMetadata(identifier).addQuads(quads);
    if (!isContainerIdentifier(identifier) && !metadata.contentType) {
      metadata.contentType = INTERNAL_QUADS;
    }
    return metadata;
  }

  public async* getChildren(identifier: ResourceIdentifier): AsyncIterableIterator<RepresentationMetadata> {
    await this.initialize();
    const name = namedNode(identifier.path);
    const scan = await this.rdfEngine.scan({
      pattern: {
        graph: name,
        subject: name,
        predicate: LDP.terms.contains,
      },
      options: { order: ['object'] },
    });
    for (const entry of scan.quads) {
      if (entry.object.termType === 'NamedNode') {
        yield new RepresentationMetadata(entry.object as NamedNode);
      }
    }
  }

  public async writeContainer(identifier: ResourceIdentifier, metadata: RepresentationMetadata): Promise<void> {
    await this.initialize();
    addResourceMetadata(metadata, true);
    updateModifiedDate(metadata);
    const { name, parent } = this.getRelatedNames(identifier);
    await this.replaceMetadata(name, metadata, parent);
  }

  public async writeDocument(
    identifier: ResourceIdentifier,
    data: Guarded<Readable>,
    metadata: RepresentationMetadata,
  ): Promise<void> {
    await this.initialize();
    if (this.isMetadataIdentifier(identifier)) {
      throw new ConflictHttpError('Not allowed to create NamedNodes with the metadata extension.');
    }

    const triples = await arrayifyStream<Quad>(data);
    const def = defaultGraph();
    if (triples.some((triple): boolean => !def.equals(triple.graph))) {
      throw new NotImplementedHttpError('Only triples in the default graph are supported.');
    }

    addResourceMetadata(metadata, false);
    updateModifiedDate(metadata);
    metadata.removeAll(CONTENT_TYPE_TERM);
    const { name, parent } = this.getRelatedNames(identifier);
    await this.rdfEngine.delete({ graph: name });
    await this.replaceMetadata(name, metadata, parent);
    await this.putGraphQuads(name, triples);
  }

  public async writeRdfSourceDocument(
    identifier: ResourceIdentifier,
    quads: Quad[],
    metadata: RepresentationMetadata,
    source: RdfSourceInput,
  ): Promise<void> {
    await this.initialize();
    if (this.isMetadataIdentifier(identifier)) {
      throw new ConflictHttpError('Not allowed to create NamedNodes with the metadata extension.');
    }

    const def = defaultGraph();
    if (quads.some((value): boolean => !def.equals(value.graph))) {
      throw new NotImplementedHttpError('Only triples in the default graph are supported.');
    }

    metadata.removeAll(CONTENT_TYPE_TERM);
    const { name, parent } = this.getRelatedNames(identifier);
    await this.replaceMetadata(name, metadata, parent);
    await this.rdfEngine.replaceSource(
      quads.map((value) => quad(value.subject, value.predicate, value.object, name) as Quad),
      source,
    );
  }

  public async indexTextSource(source: RdfTextSourceInput, text: string, chunks?: RdfTextChunkInput[]): Promise<void> {
    await this.initialize();
    if (!this.rdfEngine.indexTextSource) {
      throw new Error('SolidRdfDataAccessor text indexing requires an RDF engine with text index support');
    }
    await this.rdfEngine.indexTextSource(source, text, chunks);
  }

  public async deleteTextSource(source: string): Promise<number> {
    await this.initialize();
    if (!this.rdfEngine.deleteTextSource) {
      return 0;
    }
    return await this.rdfEngine.deleteTextSource(source);
  }

  public async moveTextSource(oldSource: string, next: RdfTextSourceInput): Promise<number> {
    await this.initialize();
    if (!this.rdfEngine.moveTextSource) {
      return 0;
    }
    return await this.rdfEngine.moveTextSource(oldSource, next);
  }

  public async moveRdfSourceDocument(oldSource: string, next: RdfSourceInput): Promise<number> {
    await this.initialize();
    if (!this.rdfEngine.moveSource) {
      return 0;
    }
    return await this.rdfEngine.moveSource(oldSource, next);
  }

  public async indexVectorSource(source: RdfVectorSourceInput, chunks: RdfVectorChunkInput[]): Promise<void> {
    await this.initialize();
    if (!this.rdfEngine.indexVectorSource) {
      throw new Error('SolidRdfDataAccessor vector indexing requires an RDF engine with vector index support');
    }
    await this.rdfEngine.indexVectorSource(source, chunks);
  }

  public async deleteVectorSource(source: string): Promise<number> {
    await this.initialize();
    if (!this.rdfEngine.deleteVectorSource) {
      return 0;
    }
    return await this.rdfEngine.deleteVectorSource(source);
  }

  public async moveVectorSource(oldSource: string, next: RdfVectorSourceInput): Promise<number> {
    await this.initialize();
    if (!this.rdfEngine.moveVectorSource) {
      return 0;
    }
    return await this.rdfEngine.moveVectorSource(oldSource, next);
  }

  public async deleteRdfSourceDocument(identifier: ResourceIdentifier): Promise<void> {
    await this.initialize();
    const { name, parent } = this.getRelatedNames(identifier);
    await this.rdfEngine.deleteSource(identifier.path);
    await this.rdfEngine.delete({ graph: this.getMetadataNode(name) });
    if (parent) {
      await this.rdfEngine.delete({
        graph: parent,
        subject: parent,
        predicate: LDP.terms.contains,
        object: name,
      });
    }
  }

  public async writeMetadata(identifier: ResourceIdentifier, metadata: RepresentationMetadata): Promise<void> {
    await this.initialize();
    const { name, parent } = this.getRelatedNames(identifier);
    const metaName = this.getMetadataNode(name);
    await this.rdfEngine.delete({ graph: metaName });
    const inserts = this.toGraphQuads(metaName, metadata.quads());
    if (parent) {
      inserts.push(quad(parent, LDP.terms.contains, name, parent) as Quad);
    }
    await this.rdfEngine.put(inserts);
  }

  public async deleteResource(identifier: ResourceIdentifier): Promise<void> {
    await this.initialize();
    const { name, parent } = this.getRelatedNames(identifier);
    await this.rdfEngine.delete({ graph: name });
    await this.rdfEngine.delete({ graph: this.getMetadataNode(name) });
    if (parent) {
      await this.rdfEngine.delete({
        graph: parent,
        subject: parent,
        predicate: LDP.terms.contains,
        object: name,
      });
    }
  }

  public async getDataByGraphPrefix(prefix: string): Promise<Quint[]> {
    await this.initialize();
    const scan = await this.rdfEngine.scan({
      pattern: {
        graph: { $startsWith: prefix },
      },
    });
    return scan.quads as Quint[];
  }

  public async prepareSparqlUpdate(
    query: string,
    baseIri: string,
    accessScope?: RdfNativeSparqlAccessScope,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<RdfPreparedUpdateDelta | undefined> {
    await this.initialize();
    if (!this.rdfEngine.sparqlQuery) {
      return this.prepareEmbeddedSparqlUpdate(query, baseIri, accessScope);
    }
    const result = await this.rdfEngine.sparqlQuery(query, {
      basePath: baseIri,
      sourceUri: baseIri,
      operation: 'prepareUpdate',
      acceptMediaType: PREPARED_UPDATE_MEDIA_TYPE,
      ...(accessScope ? { accessScope } : {}),
      ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options?.signal ? { signal: options.signal } : {}),
    });
    if (result.status === 'unsupported') {
      throw new UnsupportedSparqlQueryError(
        result.error || 'Native QLever cannot prepare this SPARQL update for file-authority commit',
      );
    }
    if (result.status !== 'ok') {
      throw new NativeSparqlExecutionError(result.error || 'Native QLever failed to prepare the SPARQL update');
    }
    if (result.mediaType !== PREPARED_UPDATE_MEDIA_TYPE) {
      throw new NativeSparqlExecutionError(`Native prepared update returned unexpected media type ${result.mediaType}`);
    }
    return parsePreparedUpdateDelta(result.body);
  }

  private async prepareEmbeddedSparqlUpdate(
    query: string,
    baseIri: string,
    accessScope?: RdfNativeSparqlAccessScope,
  ): Promise<RdfPreparedUpdateDelta> {
    let delta: ReturnType<RdfSparqlAdapter['compileUpdateDelta']>;
    try {
      delta = this.sparqlAdapter.compileUpdateDelta(query, baseIri, {
        defaultGraph: baseIri.endsWith('/') ? undefined : baseIri,
      });
    } catch (error) {
      throw normalizeAdapterError(error);
    }

    const graphDeltas = new Map<string, RdfPreparedUpdateGraphDelta>();
    const appendDeletes = (quads: Quad[]): void => {
      for (const quad of quads) {
        graphDeltaFor(graphDeltas, quad).deletes.push(quad);
      }
    };
    const appendInserts = (quads: Quad[]): void => {
      for (const quad of quads) {
        graphDeltaFor(graphDeltas, quad).inserts.push(quad);
      }
    };

    for (const operation of delta.operations) {
      if (operation.type === 'delete') {
        appendDeletes(operation.quads);
      } else if (operation.type === 'insert') {
        appendInserts(operation.quads);
      } else if (operation.type === 'insertDeleteWhere') {
        const result = await this.rdfEngine.query(applyRdfAccessScope(operation.query, accessScope as RdfAccessScope | undefined));
        appendDeletes(this.sparqlAdapter.materializeDeleteWhere(operation.deletes, result.bindings));
        appendInserts(this.sparqlAdapter.materializeDeleteWhere(operation.inserts, result.bindings));
      } else if (operation.type === 'insertWhere') {
        const result = await this.rdfEngine.query(applyRdfAccessScope(operation.query, accessScope as RdfAccessScope | undefined));
        appendInserts(this.sparqlAdapter.materializeDeleteWhere(operation.inserts, result.bindings));
      } else {
        const result = await this.rdfEngine.query(applyRdfAccessScope(operation.query, accessScope as RdfAccessScope | undefined));
        appendDeletes(this.sparqlAdapter.materializeDeleteWhere(operation.template, result.bindings));
      }
    }

    return {
      version: 1,
      graphs: [ ...graphDeltas.values() ],
    };
  }

  private getRelatedNames(identifier: ResourceIdentifier): { name: NamedNode; parent?: NamedNode } {
    const name = namedNode(identifier.path);

    if (this.identifierStrategy.isRootContainer(identifier)) {
      return { name };
    }

    const parentIdentifier = this.identifierStrategy.getParentContainer(identifier);
    const parent = namedNode(parentIdentifier.path);
    return { name, parent };
  }

  protected getMetadataNode(name: NamedNode): NamedNode {
    return namedNode(`meta:${name.value}`);
  }

  private isMetadataIdentifier(identifier: ResourceIdentifier): boolean {
    return identifier.path.startsWith('meta:');
  }

  private async replaceMetadata(name: NamedNode, metadata: RepresentationMetadata, parent?: NamedNode): Promise<void> {
    const metaName = this.getMetadataNode(name);
    await this.rdfEngine.delete({ graph: metaName });
    const inserts = this.toGraphQuads(metaName, metadata.quads());
    if (parent) {
      inserts.push(quad(parent, LDP.terms.contains, name, parent) as Quad);
    }
    await this.rdfEngine.put(inserts);
  }

  private async putGraphQuads(graph: NamedNode, triples: Quad[]): Promise<void> {
    await this.rdfEngine.put(this.toGraphQuads(graph, triples));
  }

  private async scanGraph(graph: NamedNode): Promise<Quad[]> {
    const scan = await this.rdfEngine.scan({
      pattern: { graph },
      options: { order: ['subject', 'predicate', 'object'] },
    });
    return scan.quads.map((value) => quad(value.subject, value.predicate, value.object) as Quad);
  }

  private toGraphQuads(graph: NamedNode, quads: Quad[]): Quad[] {
    return quads.map((value) => quad(value.subject, value.predicate, value.object, graph) as Quad);
  }
}
