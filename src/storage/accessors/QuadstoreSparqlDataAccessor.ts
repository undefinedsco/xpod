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
  getLoggerFor,
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
import { Quadstore } from 'quadstore';
import { Engine } from 'quadstore-comunica';
import { getBackend } from '../../libs/backends';


const { defaultGraph, namedNode, quad, variable } = DataFactory;


export class QuadstoreSparqlDataAccessor implements DataAccessor {
  protected readonly logger = getLoggerFor(this);
  private readonly endpoint: string;
  private readonly publicEndpoint: string;
  private readonly identifierStrategy: IdentifierStrategy;
  private readonly store: Quadstore;
  private readonly engine: Engine;
  private readonly generator: SparqlGenerator;

  public constructor(endpoint: string, identifierStrategy: IdentifierStrategy) {
    this.endpoint = endpoint;
    this.publicEndpoint = this.getPublicEndpoint(endpoint);
    this.identifierStrategy = identifierStrategy;
    this.generator = new Generator();
    const backend = getBackend(endpoint, { tableName: 'quadstore' });
    this.store = new Quadstore({
      backend,
      dataFactory: DataFactory,
    });
    this.engine = new Engine(this.store);
  }

  /**
   * Get the public endpoint from the given endpoint.
   */
  private getPublicEndpoint(endpoint: string): string {
    if (endpoint.startsWith('sqlite:')) {
      return endpoint;
    }
    const url = new URL(endpoint);
    const host = url.host.split(':')[0];
    return `${url.protocol}//${host}`;
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
   * Note that this will not throw a 404 if no results were found.
   */
  public async getData(identifier: ResourceIdentifier): Promise<Guarded<Readable>> {
    this.logger.info(`Getting data for ${identifier.path}`);
    const name = namedNode(identifier.path);
    return this.sendSparqlConstruct(this.sparqlConstruct(name));
  }

  /**
   * Returns the metadata for the corresponding identifier.
   * Will throw 404 if no metadata was found.
   */
  public async getMetadata(identifier: ResourceIdentifier): Promise<RepresentationMetadata> {
    this.logger.info(`Getting metadata for ${identifier.path}`);
    const name = namedNode(identifier.path);
    const query = this.sparqlConstruct(this.getMetadataNode(name));
    const stream = await this.sendSparqlConstruct(query);
    const quads: Quad[] = await arrayifyStream(stream);

    if (quads.length === 0) {
      throw new NotFoundHttpError();
    }

    const metadata = new RepresentationMetadata(identifier).addQuads(quads);
    if (!isContainerIdentifier(identifier)) {
      metadata.contentType = INTERNAL_QUADS;
    }

    return metadata;
  }

  public async* getChildren(identifier: ResourceIdentifier): AsyncIterableIterator<RepresentationMetadata> {
    this.logger.verbose(`Getting children for ${identifier.path}`);
    // Only triples that have a container identifier as subject are the containment triples
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
    this.logger.info(`Writing container ${identifier.path} ${JSON.stringify(metadata.contentTypeObject)}}`);
    addResourceMetadata(metadata, true);
    updateModifiedDate(metadata);
    const { name, parent } = this.getRelatedNames(identifier);
    return this.sendSparqlUpdate(this.sparqlInsert(name, metadata, parent));
  }

  /**
   * Reads the given data stream and stores it together with the metadata.
   */
  public async writeDocument(identifier: ResourceIdentifier, data: Guarded<Readable>, metadata: RepresentationMetadata):
  Promise<void> {
    this.logger.info(`Writing document ${identifier.path} ${JSON.stringify(metadata.contentTypeObject)}}`);
    if (this.isMetadataIdentifier(identifier)) {
      throw new ConflictHttpError('Not allowed to create NamedNodes with the metadata extension.');
    }
    const { name, parent } = this.getRelatedNames(identifier);

    const triples = await arrayifyStream<Quad>(data);
    const def = defaultGraph();
    if (triples.some((triple): boolean => !def.equals(triple.graph))) {
      throw new NotImplementedHttpError('Only triples in the default graph are supported.');
    }

    // Not relevant since all content is triples
    metadata.removeAll(CONTENT_TYPE_TERM);

    return this.sendSparqlUpdate(this.sparqlInsert(name, metadata, parent, triples));
  }

  /**
   * Reads the metadata and stores it.
   */
  public async writeMetadata(identifier: ResourceIdentifier, metadata: RepresentationMetadata): Promise<void> {
    this.logger.info(`Writing metadata for ${identifier.path} ${JSON.stringify(metadata.contentTypeObject)}`);
    const { name } = this.getRelatedNames(identifier);
    const metaName = this.getMetadataNode(name);

    return this.sendSparqlUpdate(this.sparqlInsertMetadata(metaName, metadata));
  }

  /**
   * Removes all graph data relevant to the given identifier.
   */
  public async deleteResource(identifier: ResourceIdentifier): Promise<void> {
    const { name, parent } = this.getRelatedNames(identifier);
    return this.sendSparqlUpdate(this.sparqlDelete(name, parent));
  }

  /**
   * Helper function to get named nodes corresponding to the identifier and its parent container.
   * In case of a root container only the name will be returned.
   */
  private getRelatedNames(identifier: ResourceIdentifier): { name: NamedNode; parent?: NamedNode } {
    this.logger.info(`Getting related names for ${identifier.path}`);
    const name = namedNode(identifier.path);

    // Root containers don't have a parent
    if (this.identifierStrategy.isRootContainer(identifier)) {
      return { name };
    }

    const parentIdentifier = this.identifierStrategy.getParentContainer(identifier);
    const parent = namedNode(parentIdentifier.path);
    return { name, parent };
  }

  /**
   * Creates the name for the metadata of a resource.
   *
   * @param name - Name of the (non-metadata) resource.
   */
  protected getMetadataNode(name: NamedNode): NamedNode {
    return namedNode(`meta:${name.value}`);
  }

  /**
   * Checks if the given identifier corresponds to the names used for metadata identifiers.
   */
  private isMetadataIdentifier(identifier: ResourceIdentifier): boolean {
    return identifier.path.startsWith('meta:');
  }

  /**
   * Creates a CONSTRUCT query that returns all quads contained within a single resource.
   *
   * @param name - Name of the resource to query.
   */
  protected sparqlConstruct(name: NamedNode): ConstructQuery {
    const pattern = quad(variable('s'), variable('p'), variable('o'));
    return {
      queryType: 'CONSTRUCT',
      template: [ pattern ],
      where: [ this.sparqlSelectGraph(name, [ pattern ]) ],
      type: 'query',
      prefixes: {},
    };
  }

  private sparqlSelectGraph(name: NamedNode, triples: Quad[]): GraphPattern {
    return {
      type: 'graph',
      name,
      patterns: [{ type: 'bgp', triples }],
    };
  }

  /**
   * Creates an update query that overwrites the data and metadata of a resource.
   * If there are no triples we assume it's a container (so don't overwrite the main graph with containment triples).
   *
   * @param name - Name of the resource to update.
   * @param metadata - New metadata of the resource.
   * @param parent - Name of the parent to update the containment triples.
   * @param triples - New data of the resource.
   */
  private sparqlInsert(name: NamedNode, metadata: RepresentationMetadata, parent?: NamedNode, triples?: Quad[]):
  Update {
    this.logger.verbose(`Inserting ${name.value} with metadata:`);
    for (const quad of metadata.quads()) {
      this.logger.verbose(`  ${quad.subject.value} ${quad.predicate.value} ${quad.object.value}`);
    }
    this.logger.verbose(`parent: ${parent?.value} with triples:`);
    for (const quad of triples || []) {
      this.logger.verbose(`  ${quad.subject.value} ${quad.predicate.value} ${quad.object.value}`);
    }
    const metaName = this.getMetadataNode(name);

    // Insert new metadata and containment triple
    const insert: GraphQuads[] = [ this.sparqlUpdateGraph(metaName, metadata.quads()) ];
    if (parent) {
      insert.push(this.sparqlUpdateGraph(parent, [ quad(parent, LDP.terms.contains, name) ]));
    }

    // Necessary updates: delete metadata and insert new data
    const updates: UpdateOperation[] = [
      this.sparqlUpdateDeleteAll(metaName),
      {
        updateType: 'insert',
        insert,
      },
    ];

    // Only overwrite data triples for documents
    if (triples) {
      // This needs to be first so it happens before the insert
      updates.unshift(this.sparqlUpdateDeleteAll(name));
      if (triples.length > 0) {
        insert.push(this.sparqlUpdateGraph(name, triples));
      }
    }

    return {
      updates,
      type: 'update',
      prefixes: {},
    };
  }

  /**
   * Creates an update query that overwrites metadata of a resource.
   *
   * @param metaName - Name of the metadata resource to update.
   * @param metadata - New metadata of the resource.
   */
  private sparqlInsertMetadata(metaName: NamedNode, metadata: RepresentationMetadata): Update {
    this.logger.verbose(`Inserting metadata NamedNode[${metaName}] with:`);
    for (const quad of metadata.quads()) {
      this.logger.verbose(`  ${quad.subject.value} ${quad.predicate.value} ${quad.object.value}`);
    }
    // Insert new metadata and containment triple
    const insert: GraphQuads[] = [ this.sparqlUpdateGraph(metaName, metadata.quads()) ];

    // Necessary updates: delete metadata and insert new data
    const updates: UpdateOperation[] = [
      this.sparqlUpdateDeleteAll(metaName),
      {
        updateType: 'insert',
        insert,
      },
    ];

    return {
      updates,
      type: 'update',
      prefixes: {},
    };
  }

  /**
   * Creates a query that deletes everything related to the given name.
   *
   * @param name - Name of resource to delete.
   * @param parent - Parent of the resource to delete so the containment triple can be removed (unless root).
   */
  private sparqlDelete(name: NamedNode, parent?: NamedNode): Update {
    this.logger.info(`Deleting ${name.value} with parent ${parent?.value}`);
    const update: Update = {
      updates: [
        this.sparqlUpdateDeleteAll(name),
        this.sparqlUpdateDeleteAll(this.getMetadataNode(name)),
      ],
      type: 'update',
      prefixes: {},
    };

    if (parent) {
      update.updates.push({
        updateType: 'delete',
        delete: [
          this.sparqlUpdateGraph(parent, [ quad(parent, LDP.terms.contains, name) ])
        ],
      });
    }

    return update;
  }

  /**
   * Helper function for creating SPARQL update queries.
   * Creates an operation for deleting all triples in a graph.
   *
   * @param name - Name of the graph to delete.
   */
  private sparqlUpdateDeleteAll(name: NamedNode): InsertDeleteOperation {
    this.logger.info(`Deleting all from ${name.value}`);
    return {
      updateType: 'deletewhere',
      delete: [
        this.sparqlUpdateGraph(
          name, [ quad(variable(`s`), variable(`p`), variable(`o`)) ]
        )
      ],
    };
  }

  /**
   * Helper function for creating SPARQL update queries.
   * Creates a Graph selector with the given triples.
   *
   * @param name - Name of the graph.
   * @param triples - Triples/triple patterns to select.
   */
  private sparqlUpdateGraph(name: NamedNode, triples: Quad[]): GraphQuads {
    this.logger.verbose(`Creating graph ${name.value} with:`);
    for (const quad of triples) {
      this.logger.verbose(`  ${quad.subject.value} ${quad.predicate.value} ${quad.object.value}`);
    }
    return { type: 'graph', name, triples };
  }

  /**
   * Sends a SPARQL CONSTRUCT query to the endpoint and returns a stream of quads.
   *
   * @param sparqlQuery - Query to execute.
   */
  protected async sendSparqlConstruct(sparqlQuery: ConstructQuery): Promise<Guarded<Readable>> {
    const query = this.generator.stringify(sparqlQuery);
    const logger = this.logger;
    logger.verbose(`Sending SPARQL CONSTRUCT query to ${this.publicEndpoint}: ${query}`);
    try {
      await this.waitForStoreReady();
      const start = Date.now();
      const result = await this.engine.queryQuads(query);
      const end = Date.now();
      logger.verbose(`SPARQL CONSTRUCT query success. cost time: ${end - start}ms`);
      const readable = new Readable({ objectMode: true, read() {} });

      result.on('start', () => {
        logger.debug(`SPARQL CONSTRUCT query start. cost time: ${Date.now() - start}ms`);
      });
      result.on(
        'data',
        (chunk) => {
          readable.push(chunk);
        }
      );
      result.on('end', () => {
        logger.debug(`SPARQL CONSTRUCT query end. cost time: ${Date.now() - start}ms`);
        readable.push(null);
      });
      result.on('error', (error) => {
        logger.error(`SPARQL CONSTRUCT stream error: ${error}`);
        readable.emit('error', error);
      });

      return guardStream(readable);
    } catch (error: unknown) {
      logger.error(`SPARQL ${query} endpoint ${this.publicEndpoint} error: ${createErrorMessage(error)}`);
      throw error;
    }
  }

  /**
   * Sends a SPARQL update query to the stored endpoint.
   *
   * @param sparqlQuery - Query to send.
   */
  private async sendSparqlUpdate(sparqlQuery: Update): Promise<void> {
    const query = this.generator.stringify(sparqlQuery);
    this.logger.verbose(`Sending SPARQL UPDATE query to ${this.publicEndpoint}: ${query}`);
    try {
      await this.waitForStoreReady();
      const start = Date.now();
      await this.engine.queryVoid(query);
      const end = Date.now();
      this.logger.verbose(`SPARQL UPDATE query success. cost time: ${end - start}ms`);
    } catch (error: unknown) {
      this.logger.error(`SPARQL ${query} endpoint ${this.publicEndpoint} error: ${createErrorMessage(error)}`);
      throw error;
    }
  }

  /**
   * Execute an arbitrary SPARQL UPDATE string.
   */
  public async executeSparqlUpdate(query: string, baseIri?: string): Promise<void> {
    this.logger.verbose(`Executing SPARQL UPDATE on ${this.publicEndpoint}: ${query}`);
    await this.waitForStoreReady();
    await this.engine.queryVoid(query, { baseIRI: baseIri });
  }

  /**
   * Execute a SPARQL SELECT query and return bindings as plain objects.
   */
  public async executeSparqlSelect(query: string): Promise<Record<string, string>[]> {
    this.logger.verbose(`Executing SPARQL SELECT on ${this.publicEndpoint}: ${query}`);
    await this.waitForStoreReady();
    const bindingsStream = await this.engine.queryBindings(query);
    const results: Record<string, string>[] = [];
    const iterable = bindingsStream as unknown as AsyncIterable<Map<string, unknown>>;
    for await (const binding of iterable) {
      const row: Record<string, string> = {};
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore Comunica bindings expose Map-like iteration
      for (const [ key, value ] of binding) {
        row[key] = (value as { value: string }).value;
      }
      results.push(row);
    }
    return results;
  }

  /**
   * Execute a SPARQL ASK query.
   */
  public async executeSparqlAsk(query: string): Promise<boolean> {
    this.logger.verbose(`Executing SPARQL ASK on ${this.publicEndpoint}: ${query}`);
    await this.waitForStoreReady();
    return this.engine.queryBoolean(query);
  }

  /**
   * Execute a raw CONSTRUCT query string.
   */
  public async executeSparqlConstruct(query: string): Promise<Guarded<Readable>> {
    this.logger.verbose(`Executing SPARQL CONSTRUCT on ${this.publicEndpoint}: ${query}`);
    await this.waitForStoreReady();
    const result = await this.engine.queryQuads(query);
    const readable = new Readable({
      objectMode: true,
      read() {
        result.on('data', (quad): void => {
          this.push(quad);
        });
        result.on('end', (): void => {
          this.push(null);
        });
      },
    });
    return guardStream(readable);
  }

  /**
   * Wait for the store to be ready.
   */
  private async waitForStoreReady(): Promise<void> {
    if (this.store.db.status !== 'open' && this.store.db.status !== 'opening') {
      throw new Error('Store is not open');
    }
    while (this.store.db.status !== 'open') {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }


  /**
   * Closes the underlying store.
   */
  public async close(): Promise<void> {
    await this.store.close();
  }
}
