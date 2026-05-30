import { Readable } from 'node:stream';
import arrayifyStream from 'arrayify-stream';
import { getLoggerFor } from 'global-logger-factory';
import { DataFactory } from 'n3';
import type { NamedNode, Quad } from '@rdfjs/types';
import {
  addResourceMetadata,
  CONTENT_TYPE_TERM,
  ConflictHttpError,
  createErrorMessage,
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
import type { RdfSparqlUpdateDeltaOperation, RdfSparqlUpdateTemplate } from '../rdf/RdfSparqlAdapter';
import {
  DisabledSparqlFeatureError,
  RdfSparqlAdapter,
  UnsupportedSparqlQueryError,
} from '../rdf/RdfSparqlAdapter';
import type { RdfBindingRow, RdfEngineLike, RdfSourceInput } from '../rdf/types';
import type { Quint } from '../quint/types';

const { defaultGraph, namedNode, quad } = DataFactory;

/**
 * Structured RDF DataAccessor backed directly by SolidRdfEngine.
 *
 * This is the server-owned Pod storage path. It writes resource graphs and
 * metadata graphs into the term-id RDF index without routing simple CSS LDP
 * operations through Comunica.
 */
export class SolidRdfDataAccessor implements DataAccessor {
  protected readonly logger = getLoggerFor(this);
  private readonly adapter = new RdfSparqlAdapter();
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

  public async executeSparqlUpdate(query: string, baseIri?: string): Promise<void> {
    await this.initialize();
    try {
      const delta = this.adapter.compileUpdateDelta(query, baseIri ?? '', {
        defaultGraph: baseIri,
      });
      for (const operation of delta.operations) {
        await this.applyUpdateOperation(operation);
      }
    } catch (error: unknown) {
      if (error instanceof DisabledSparqlFeatureError) {
        throw error;
      }
      if (error instanceof UnsupportedSparqlQueryError) {
        this.logger.warn(`SolidRdfDataAccessor cannot execute SPARQL UPDATE without compatibility fallback: ${error.message}`);
        throw error;
      }
      this.logger.error(`SPARQL update failed: ${createErrorMessage(error)}`);
      throw error;
    }
  }

  private async applyUpdateOperation(operation: RdfSparqlUpdateDeltaOperation): Promise<void> {
    if (operation.type === 'insert') {
      await this.rdfEngine.put(operation.quads);
      return;
    }
    if (operation.type === 'delete') {
      for (const value of operation.quads) {
        await this.rdfEngine.delete({
          graph: value.graph,
          subject: value.subject,
          predicate: value.predicate,
          object: value.object,
        });
      }
      return;
    }

    if (operation.type === 'deleteWhere') {
      const result = await this.rdfEngine.query(operation.query);
      await this.deleteMaterialized(operation.template, result.bindings);
      return;
    }

    if (operation.type === 'insertWhere') {
      const result = await this.rdfEngine.query(operation.query);
      await this.rdfEngine.put(this.adapter.materializeDeleteWhere(
        operation.inserts,
        result.bindings,
      ));
      return;
    }

    const result = await this.rdfEngine.query(operation.query);
    const rows = result.bindings;
    await this.deleteMaterialized(operation.deletes, rows);
    await this.rdfEngine.put(this.adapter.materializeDeleteWhere(operation.inserts, rows));
  }

  private async deleteMaterialized(template: RdfSparqlUpdateTemplate[], rows: RdfBindingRow[]): Promise<void> {
    for (const value of this.adapter.materializeDeleteWhere(template, rows)) {
      await this.rdfEngine.delete({
        graph: value.graph,
        subject: value.subject,
        predicate: value.predicate,
        object: value.object,
      });
    }
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
