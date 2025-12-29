/**
 * QuintStoreSparqlDataAccessor - Data accessor using QuintStore
 * 
 * Key features:
 * 1. Graph prefix filtering for efficient subgraph queries
 * 2. Backend-agnostic storage (SQLite, PostgreSQL, etc.)
 * 3. Future: vector similarity search
 */

import { getLoggerFor } from 'global-logger-factory';
import { Readable } from 'node:stream';
import arrayifyStream from 'arrayify-stream';

import { DataFactory } from 'n3';
import type { NamedNode, Quad } from '@rdfjs/types';
import type {
  ConstructQuery,
  GraphPattern,
  GraphQuads,
  InsertDeleteOperation,
  SparqlGenerator,
  Update,
  UpdateOperation,
} from 'sparqljs';
import { Generator } from 'sparqljs';
import {
  DataAccessor,
  RepresentationMetadata,
  IdentifierStrategy,
  addResourceMetadata,
  updateModifiedDate,
  
  type Representation,
  type ResourceIdentifier,
  INTERNAL_QUADS,
  ConflictHttpError,
  NotFoundHttpError,
  NotImplementedHttpError,
  UnsupportedMediaTypeHttpError,
  guardStream,
  type Guarded,
  isContainerIdentifier,
  CONTENT_TYPE_TERM,
  LDP,
  createErrorMessage,
} from '@solid/community-server';

import type { QuintStore, Quint } from '../quint/types';
import { ComunicaQuintEngine } from '../sparql/ComunicaQuintEngine';

const { defaultGraph, namedNode, quad, variable } = DataFactory;

export class QuintStoreSparqlDataAccessor implements DataAccessor {
  protected readonly logger = getLoggerFor(this);
  private readonly identifierStrategy: IdentifierStrategy;
  private readonly store: QuintStore;
  private readonly engine: ComunicaQuintEngine;
  private readonly generator: SparqlGenerator;
  private initialized = false;

  public constructor(
    store: QuintStore,
    identifierStrategy: IdentifierStrategy,
  ) {
    this.store = store;
    this.identifierStrategy = identifierStrategy;
    this.generator = new Generator();
    this.engine = new ComunicaQuintEngine(this.store);
  }

  /**
   * Initialize the store (open database connection)
   */
  public async initialize(): Promise<void> {
    if (!this.initialized) {
      await this.store.open();
      this.initialized = true;
      this.logger.info('QuintStore initialized');
    }
  }

  /**
   * Close the store
   */
  public async finalize(): Promise<void> {
    if (this.initialized) {
      await this.store.close();
      this.initialized = false;
      this.logger.info('QuintStore closed');
    }
  }

  /**
   * Only Quad data streams are supported.
   */
  public async canHandle(representation: Representation): Promise<void> {
    if (representation.binary || representation.metadata.contentType !== INTERNAL_QUADS) {
      throw new UnsupportedMediaTypeHttpError('Only Quad data is supported.');
    }
  }

  /**
   * Returns all triples stored for the corresponding identifier.
   */
  public async getData(identifier: ResourceIdentifier): Promise<Guarded<Readable>> {
    await this.initialize();
    const name = namedNode(identifier.path);
    return this.sendSparqlConstruct(this.sparqlConstruct(name));
  }

  /**
   * Returns the metadata for the corresponding identifier.
   */
  public async getMetadata(identifier: ResourceIdentifier): Promise<RepresentationMetadata> {
    await this.initialize();
    this.logger.debug(`getMetadata: ${identifier.path}`);
    const name = namedNode(identifier.path);
    const query = this.sparqlConstruct(this.getMetadataNode(name));
    const stream = await this.sendSparqlConstruct(query);
    const quads: Quad[] = await arrayifyStream(stream);

    if (quads.length === 0) {
      throw new NotFoundHttpError();
    }

    const metadata = new RepresentationMetadata(identifier).addQuads(quads);
    // Only set default contentType if not already present in metadata
    if (!isContainerIdentifier(identifier) && !metadata.contentType) {
      metadata.contentType = INTERNAL_QUADS;
    }

    return metadata;
  }

  public async* getChildren(identifier: ResourceIdentifier): AsyncIterableIterator<RepresentationMetadata> {
    await this.initialize();
    const name = namedNode(identifier.path);
    const stream = await this.sendSparqlConstruct(this.sparqlConstruct(name));
    for await (const entry of stream) {
      yield new RepresentationMetadata((entry as Quad).object as NamedNode);
    }
  }

  /**
   * Writes the given metadata for the container.
   */
  public async writeContainer(identifier: ResourceIdentifier, metadata: RepresentationMetadata): Promise<void> {
    await this.initialize();
    addResourceMetadata(metadata, true);
    updateModifiedDate(metadata);
    const { name, parent } = this.getRelatedNames(identifier);
    return this.sendSparqlUpdate(this.sparqlInsert(name, metadata, parent));
  }

  /**
   * Reads the given data stream and stores it together with the metadata.
   */
  public async writeDocument(
    identifier: ResourceIdentifier,
    data: Guarded<Readable>,
    metadata: RepresentationMetadata,
  ): Promise<void> {
    await this.initialize();
    if (this.isMetadataIdentifier(identifier)) {
      throw new ConflictHttpError('Not allowed to create NamedNodes with the metadata extension.');
    }
    const { name, parent } = this.getRelatedNames(identifier);

    const triples = await arrayifyStream<Quad>(data);
    const def = defaultGraph();
    if (triples.some((triple): boolean => !def.equals(triple.graph))) {
      throw new NotImplementedHttpError('Only triples in the default graph are supported.');
    }

    metadata.removeAll(CONTENT_TYPE_TERM);
    return this.sendSparqlUpdate(this.sparqlInsert(name, metadata, parent, triples));
  }

  /**
   * Reads the metadata and stores it.
   */
  public async writeMetadata(identifier: ResourceIdentifier, metadata: RepresentationMetadata): Promise<void> {
    await this.initialize();
    const { name } = this.getRelatedNames(identifier);
    const metaName = this.getMetadataNode(name);
    return this.sendSparqlUpdate(this.sparqlInsertMetadata(metaName, metadata));
  }

  /**
   * Removes all graph data relevant to the given identifier.
   */
  public async deleteResource(identifier: ResourceIdentifier): Promise<void> {
    await this.initialize();
    const { name, parent } = this.getRelatedNames(identifier);
    return this.sendSparqlUpdate(this.sparqlDelete(name, parent));
  }

  // ============================================
  // QuintStore specific methods
  // ============================================

  /**
   * Get data with graph prefix filtering (key feature!)
   * This is much more efficient than full SPARQL for subgraph queries.
   */
  public async getDataByGraphPrefix(prefix: string): Promise<Quint[]> {
    await this.initialize();
    return this.store.getByGraphPrefix(prefix);
  }

  /**
   * Execute SPARQL query with graph prefix filtering
   */
  public async queryWithGraphPrefix(
    query: string,
    graphPrefix: string,
  ): Promise<Quad[]> {
    await this.initialize();
    const stream = await this.engine.queryBindings(query, { graphPrefix });
    return arrayifyStream(stream);
  }

  // ============================================
  // Private helpers
  // ============================================

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

  protected sparqlConstruct(name: NamedNode): ConstructQuery {
    const pattern = quad(variable('s'), variable('p'), variable('o'));
    return {
      queryType: 'CONSTRUCT',
      template: [pattern],
      where: [this.sparqlSelectGraph(name, [pattern])],
      type: 'query',
      prefixes: {},
    };
  }

  private sparqlSelectGraph(name: NamedNode, triples: Quad[]): GraphPattern {
    return {
      type: 'graph',
      name,
      patterns: [{ type: 'bgp', triples }],
    } as GraphPattern;
  }

  private sparqlSelectGraphAsQuads(name: NamedNode, triples: Quad[]): any {
    return this.sparqlSelectGraph(name, triples);
  }

  /**
   * Creates an update query that overwrites the data and metadata of a resource.
   * If triples is undefined, we assume it's a container (so don't overwrite the main graph with containment triples).
   * This follows the same pattern as CSS's SparqlDataAccessor.
   *
   * @param name - Name of the resource to update.
   * @param metadata - New metadata of the resource.
   * @param parent - Name of the parent to update the containment triples.
   * @param triples - New data of the resource (undefined for containers).
   */
  private sparqlInsert(
    name: NamedNode,
    metadata: RepresentationMetadata,
    parent?: NamedNode,
    triples?: Quad[],
  ): Update {
    const metaName = this.getMetadataNode(name);

    // Insert new metadata and containment triple
    const insert: GraphQuads[] = [
      {
        type: 'graph',
        name: metaName,
        triples: metadata.quads() as Quad[],
      },
    ];

    if (parent) {
      insert.push({
        type: 'graph',
        name: parent,
        triples: [quad(parent, LDP.terms.contains, name)],
      });
    }

    // Necessary updates: delete metadata and insert new data
    const updates: InsertDeleteOperation[] = [
      // Always delete and reinsert metadata
      {
        updateType: 'deletewhere',
        delete: [this.sparqlSelectGraphAsQuads(metaName, [quad(variable('s'), variable('p'), variable('o'))])],
      },
      {
        updateType: 'insert',
        insert,
      },
    ];

    // Only overwrite data triples for documents (when triples is defined)
    // For containers, we don't touch the data graph to preserve ldp:contains triples
    if (triples !== undefined) {
      // This needs to be first so it happens before the insert
      updates.unshift({
        updateType: 'deletewhere',
        delete: [this.sparqlSelectGraphAsQuads(name, [quad(variable('s'), variable('p'), variable('o'))])],
      });

      if (triples.length > 0) {
        insert.push({
          type: 'graph',
          name,
          triples,
        });
      }
    }

    return {
      type: 'update',
      updates,
      prefixes: {},
    };
  }

  private sparqlInsertMetadata(metaName: NamedNode, metadata: RepresentationMetadata): Update {
    const metaGraphs: GraphQuads = {
      type: 'graph',
      name: metaName,
      triples: metadata.quads() as Quad[],
    };

    const deleteOp: InsertDeleteOperation = {
      updateType: 'deletewhere',
      delete: [this.sparqlSelectGraphAsQuads(metaName, [quad(variable('s'), variable('p'), variable('o'))])],
    };

    const insertOp: InsertDeleteOperation = {
      updateType: 'insert',
      insert: [metaGraphs],
    };

    return {
      type: 'update',
      updates: [deleteOp, insertOp],
      prefixes: {},
    };
  }

  private sparqlDelete(name: NamedNode, parent?: NamedNode): Update {
    const metaName = this.getMetadataNode(name);

    const updates: UpdateOperation[] = [
      {
        updateType: 'deletewhere',
        delete: [this.sparqlSelectGraphAsQuads(name, [quad(variable('s'), variable('p'), variable('o'))])],
      },
      {
        updateType: 'deletewhere',
        delete: [this.sparqlSelectGraphAsQuads(metaName, [quad(variable('s'), variable('p'), variable('o'))])],
      },
    ];

    if (parent) {
      updates.push({
        updateType: 'deletewhere',
        delete: [{
          type: 'graph',
          name: parent,
          triples: [quad(parent, LDP.terms.contains, name)],
        }],
      });
    }

    return {
      type: 'update',
      updates,
      prefixes: {},
    };
  }

  private async sendSparqlConstruct(query: ConstructQuery): Promise<Guarded<Readable>> {
    const queryString = this.generator.stringify(query);
    this.logger.verbose(`SPARQL CONSTRUCT: ${queryString}`);

    try {
      const quadStream = await this.engine.queryQuads(queryString);
      return guardStream(Readable.from(quadStream as unknown as AsyncIterable<any>));
    } catch (error: unknown) {
      this.logger.error(`SPARQL query failed: ${createErrorMessage(error)}`);
      throw error;
    }
  }

  private async sendSparqlUpdate(query: Update): Promise<void> {
    const queryString = this.generator.stringify(query);
    this.logger.verbose(`SPARQL UPDATE: ${queryString}`);

    try {
      await this.engine.queryVoid(queryString);
    } catch (error: unknown) {
      this.logger.error(`SPARQL update failed: ${createErrorMessage(error)}`);
      throw error;
    }
  }

  /**
   * Execute a SPARQL UPDATE query string directly.
   * Used by SparqlUpdateResourceStore for LDP PATCH operations.
   */
  public async executeSparqlUpdate(query: string, baseIri?: string): Promise<void> {
    this.logger.verbose(`executeSparqlUpdate: ${query}`);
    try {
      await this.engine.queryVoid(query);
    } catch (error: unknown) {
      this.logger.error(`SPARQL update failed: ${createErrorMessage(error)}`);
      throw error;
    }
  }
}
