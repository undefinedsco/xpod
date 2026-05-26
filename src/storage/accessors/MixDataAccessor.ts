import { Readable } from 'stream';
import { getLoggerFor } from 'global-logger-factory';
import arrayifyStream from 'arrayify-stream';
import { DataFactory, Parser, Writer, termToId } from 'n3';
import jsonld from 'jsonld';
import { rdfParser } from 'rdf-parse';

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
  RdfLocalQuery,
  RdfQueryPattern,
  RdfQueryTermPattern,
  RdfSourceInput,
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

/**
 * MixDataAccessor - Routes data to appropriate storage based on content type
 * 
 * - RDF data (internal/quads) -> structuredDataAccessor (Quadstore or QuintStore)
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
   * rebuild the structured RDF index. Unsupported shapes keep using the
   * compatibility accessor until the embedded engine covers them.
   */
  public async executeSparqlUpdate(query: string, baseIri?: string): Promise<void> {
    if (baseIri) {
      const identifier = { path: baseIri };
      if (this.isByLineRdfIdentifier(identifier)) {
        try {
          await this.executeLocalRdfSparqlUpdate(query, identifier);
          this.invalidateMetadataCache(identifier);
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

  private async executeLocalRdfSparqlUpdate(
    query: string,
    identifier: ResourceIdentifier,
  ): Promise<void> {
    const delta = this.rdfSparqlAdapter.compileUpdateDelta(query, identifier.path);
    this.assertLocalRdfDeltaTargetsGraph(delta.operations, identifier.path);
    const existingText = await this.readLocalRdfTextOrEmpty(identifier);
    const graph = DataFactory.namedNode(identifier.path);
    const existingQuads = existingText.length > 0
      ? await this.parseLocalRdf(identifier, existingText, this.localRdfContentType(identifier))
        .then((quads) => quads.map((quad) => this.toGraphQuad(quad, graph)))
      : [];
    const nextQuads = this.applyLocalRdfDelta(existingQuads, delta.operations);
    const authorityQuads = nextQuads.map((quad) => this.toDefaultGraphQuad(quad));
    await this.writeLocalRdfAuthority(identifier, authorityQuads);
    await this.writeStructuredRdfIndex(identifier, authorityQuads, new RepresentationMetadata(identifier));
  }

  private applyLocalRdfDelta(
    quads: Quad[],
    operations: RdfSparqlUpdateDeltaOperation[],
  ): Quad[] {
    const byKey = new Map(quads.map((quad) => [this.quadKey(quad), quad]));

    for (const operation of operations) {
      if (operation.type === 'insert') {
        for (const quad of operation.quads) {
          byKey.set(this.quadKey(quad), quad);
        }
        continue;
      }

      if (operation.type === 'delete') {
        for (const quad of operation.quads) {
          byKey.delete(this.quadKey(quad));
        }
        continue;
      }

      if (operation.type === 'insertDeleteWhere') {
        const rows = this.queryLocalUpdateBindings([...byKey.values()], operation.query);
        for (const quad of this.rdfSparqlAdapter.materializeDeleteWhere(operation.deletes, rows)) {
          byKey.delete(this.quadKey(quad));
        }
        for (const quad of this.rdfSparqlAdapter.materializeDeleteWhere(operation.inserts, rows)) {
          byKey.set(this.quadKey(quad), quad);
        }
        continue;
      }

      if (operation.type === 'insertWhere') {
        const rows = this.queryLocalUpdateBindings([...byKey.values()], operation.query);
        for (const quad of this.rdfSparqlAdapter.materializeDeleteWhere(operation.inserts, rows)) {
          byKey.set(this.quadKey(quad), quad);
        }
        continue;
      }

      const rows = this.queryLocalUpdateBindings([...byKey.values()], operation.query);
      for (const quad of this.rdfSparqlAdapter.materializeDeleteWhere(operation.template, rows)) {
        byKey.delete(this.quadKey(quad));
      }
    }

    return [...byKey.values()];
  }

  private assertLocalRdfDeltaTargetsGraph(
    operations: RdfSparqlUpdateDeltaOperation[],
    graphIri: string,
  ): void {
    for (const operation of operations) {
      const graphTerms = operation.type === 'deleteWhere'
        ? operation.template.map((item) => item.graph)
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
        if (!('termType' in graph) || graph.termType !== 'NamedNode' || graph.value !== graphIri) {
          throw new UnsupportedSparqlQueryError('Embedded local RDF update only supports the target document graph');
        }
      }
    }
  }

  private queryLocalUpdateBindings(
    quads: Quad[],
    query: RdfLocalQuery,
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

  private queryGraphTerms(query: RdfLocalQuery): RdfQueryTermPattern[] {
    const patterns: RdfQueryPattern[] = [...query.patterns];
    for (const optional of query.optional ?? []) {
      patterns.push(...(Array.isArray(optional) ? optional : optional.patterns));
    }
    for (const union of query.unions ?? []) {
      for (const branch of union.branches) {
        patterns.push(...branch.patterns);
        for (const optional of branch.optional ?? []) {
          patterns.push(...(Array.isArray(optional) ? optional : optional.patterns));
        }
      }
    }
    return patterns.flatMap((pattern) => pattern.graph ? [pattern.graph] : []);
  }

  private async readLocalRdfTextOrEmpty(identifier: ResourceIdentifier): Promise<string> {
    try {
      return await this.readStreamText(await this.rdfFileDataAccessor.getData(identifier));
    } catch (error) {
      if (NotFoundHttpError.isInstance(error)) {
        await this.refreshLocalRdfMirror(identifier);
        try {
          return await this.readStreamText(await this.rdfFileDataAccessor.getData(identifier));
        } catch (retryError) {
          if (NotFoundHttpError.isInstance(retryError)) {
            return '';
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
    const metadata = await this.rdfFileDataAccessor.getMetadata(identifier);
    metadata.contentType = this.localRdfContentType(identifier);
    return metadata;
  }

  private createLocalRdfMetadata(
    identifier: ResourceIdentifier,
    metadata: RepresentationMetadata,
  ): RepresentationMetadata {
    const localMetadata = new RepresentationMetadata(metadata);
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
