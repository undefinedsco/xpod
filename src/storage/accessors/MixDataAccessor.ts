import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
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
  FileIdentifierMapper,
} from '@solid/community-server';
import { UnsupportedSparqlQueryError } from '../rdf/RdfSparqlBoundary';
import {
  isLineAddressableRdfPath,
  isRdfDocumentPath,
  normalizeContentType,
  rdfContentTypeForPath,
} from '../rdf/RdfContentTypes';
import { createRdfEntityTextChunks } from '../rdf/RdfTextProjection';
import { serializeRdfXml } from '../rdf/RdfXmlSerializer';
import { rdfAccessGraphAllowed, type RdfAccessScope } from '../rdf/RdfAccessScope';
import type {
  RdfPreparedUpdateDelta,
  RdfSourceInput,
  RdfTextChunkInput,
  RdfTextSourceInput,
  RdfTermRewriteInput,
  RdfTermRewriteResult,
  RdfVectorChunkInput,
  RdfVectorSourceInput,
} from '../rdf/types';
import { metadataRequestContext } from '../MetadataRequestContext';
import { isDirectDataRead } from '../ResourceReadContext';
import type { SparqlVoidOptions } from '../sparql/SubgraphQueryEngine';
import type { SolidFsChange, SolidFsManifest } from '../../solidfs/types';
import type { RdfSearchReconciliationIntentSink } from '../../search/RdfSearchIntentSink';

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
  moveLocalRdfIndex?(
    previousIdentifier: ResourceIdentifier,
    nextIdentifier: ResourceIdentifier,
    options?: LocalRdfMoveOptions,
  ): Promise<number>;
  rewriteTerms?(input: RdfTermRewriteInput): Promise<RdfTermRewriteResult> | RdfTermRewriteResult;
}

export interface LocalRdfSyncOptions {
  source?: string;
  workspace?: string;
  localPath?: string;
  sourceVersion?: string;
}

export interface LocalRdfMoveOptions extends LocalRdfSyncOptions {
  previousSource?: string;
}

export interface SourceScopedStructuredRdfAccessor {
  writeRdfSourceDocument(
    identifier: ResourceIdentifier,
    quads: Quad[],
    metadata: RepresentationMetadata,
    source: RdfSourceInput,
  ): Promise<void>;
  deleteRdfSourceDocument(identifier: ResourceIdentifier): Promise<void>;
  moveRdfSourceDocument?(oldSource: string, next: RdfSourceInput): Promise<number>;
  indexTextSource?(source: RdfTextSourceInput, text: string, chunks?: RdfTextChunkInput[]): Promise<void>;
  moveTextSource?(oldSource: string, next: RdfTextSourceInput): Promise<number>;
  deleteTextSource?(source: string): Promise<number>;
  indexVectorSource?(source: RdfVectorSourceInput, chunks: RdfVectorChunkInput[]): Promise<void>;
  moveVectorSource?(oldSource: string, next: RdfVectorSourceInput): Promise<number>;
  deleteVectorSource?(source: string): Promise<number>;
}

export interface LocalRdfAuthorityJournalOperation {
  id: string;
}

export interface LocalRdfAuthorityJournal {
  recordLocalCommitted(
    change: SolidFsChange,
    workspace: SolidFsManifest,
    txId?: string,
  ): Promise<LocalRdfAuthorityJournalOperation>;
  markDone(id: string): Promise<void>;
  markRetryableFailure(id: string, error: unknown): Promise<void>;
  markReconcileRequired(id: string, reason: string): Promise<void>;
  markFailedPermanent(id: string, error: unknown): Promise<void>;
}

interface LocalRdfAuthorityPatch {
  identifier: ResourceIdentifier;
  previousQuads: Quad[];
  previousExists: boolean;
  nextQuads: Quad[];
}

interface LocalRdfAuthorityJournalPatch {
  patch: LocalRdfAuthorityPatch;
  operation: LocalRdfAuthorityJournalOperation;
}

interface LocalRdfAuthorityJournalPatchDraft {
  patch: LocalRdfAuthorityPatch;
  change: SolidFsChange;
  workspace: SolidFsManifest;
  txId?: string;
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
export class MixDataAccessor implements DataAccessor, LocalRdfIndexAccessor {
  protected readonly logger = getLoggerFor(this);
  
  private readonly structuredDataAccessor: DataAccessor;
  private readonly unstructuredDataAccessor: DataAccessor;
  private readonly rdfFileDataAccessor: DataAccessor;
  private readonly rdfFileMapper?: FileIdentifierMapper;
  private readonly localRdfAuthorityJournal?: LocalRdfAuthorityJournal;
  private readonly presignedRedirectEnabled: boolean;
  private readonly mirrorContainersToUnstructured: boolean;
  private readonly textSearchIndexingEnabled: boolean;
  private readonly rdfSearchIntentSink?: RdfSearchReconciliationIntentSink;

  constructor(
    structuredDataAccessor: DataAccessor,
    unstructuredDataAccessor: DataAccessor,
    presignedRedirectEnabled = false,
    mirrorContainersToUnstructured = true,
    rdfFileDataAccessor: DataAccessor = unstructuredDataAccessor,
    textSearchIndexingEnabled = false,
    rdfFileMapper?: FileIdentifierMapper,
    localRdfAuthorityJournal?: LocalRdfAuthorityJournal,
    rdfSearchIntentSink?: RdfSearchReconciliationIntentSink,
  ) {
    this.structuredDataAccessor = structuredDataAccessor;
    this.unstructuredDataAccessor = unstructuredDataAccessor;
    this.rdfFileDataAccessor = rdfFileDataAccessor;
    this.rdfFileMapper = rdfFileMapper;
    this.localRdfAuthorityJournal = localRdfAuthorityJournal;
    this.presignedRedirectEnabled = presignedRedirectEnabled;
    this.mirrorContainersToUnstructured = mirrorContainersToUnstructured;
    this.textSearchIndexingEnabled = textSearchIndexingEnabled;
    this.rdfSearchIntentSink = rdfSearchIntentSink;
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
      if (this.presignedRedirectEnabled && !isDirectDataRead()) {
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
      await this.deleteSearchIndexes(identifier);
    } else if (this.isUnstructured(metadata)) {
      await this.deleteUnstructuredResourceIfPresent(identifier);
      await this.deleteSearchIndexes(identifier);
    }
    
    // Always delete from structured storage (contains metadata)
    await this.structuredDataAccessor.deleteResource(identifier);
    this.invalidateMetadataCache(identifier);
  }

  /**
   * Execute SPARQL UPDATE.
   *
   * Native QLever prepares an exact graph delta. The accessor validates its
   * write scope, patches the local RDF authority files, and rebuilds the index.
   */
  public async executeSparqlUpdate(
    query: string,
    baseIri?: string,
    accessScope?: RdfAccessScope,
    options?: SparqlVoidOptions,
  ): Promise<void> {
    if (!baseIri) {
      throw new UnsupportedSparqlQueryError(
        'Pod SPARQL UPDATE requires a server-owned base IRI',
        { code: 'rdf.sparql.update_authority_required' },
      );
    }
    const prepared = await this.prepareNativeRdfSparqlUpdate(query, baseIri, accessScope, options);
    const writtenIdentifiers = await this.executePreparedRdfSparqlUpdate(
      prepared,
      baseIri,
      accessScope,
    );
    for (const writtenIdentifier of writtenIdentifiers) {
      this.invalidateMetadataCache(writtenIdentifier);
    }
  }

  private async prepareNativeRdfSparqlUpdate(
    query: string,
    baseIri: string,
    accessScope?: RdfAccessScope,
    options?: SparqlVoidOptions,
  ): Promise<RdfPreparedUpdateDelta> {
    const accessor = this.structuredDataAccessor as {
      prepareSparqlUpdate?: (
        query: string,
        baseIri: string,
        accessScope?: RdfAccessScope,
        options?: { timeoutMs?: number; signal?: AbortSignal },
      ) => Promise<RdfPreparedUpdateDelta | undefined>;
    };
    if (typeof accessor.prepareSparqlUpdate !== 'function') {
      throw new UnsupportedSparqlQueryError(
        'Native QLever prepared-update support is required for Pod SPARQL UPDATE',
        {
          code: 'rdf.sparql.update_authority_required',
          capability: 'sparql.update.authority',
        },
      );
    }
    const prepareOptions = options
      ? {
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
          ...(options.signal ? { signal: options.signal } : {}),
        }
      : undefined;
    const prepared = await accessor.prepareSparqlUpdate(query, baseIri, accessScope, prepareOptions);
    if (!prepared) {
      throw new UnsupportedSparqlQueryError(
        'Native QLever did not return a prepared update delta',
        {
          code: 'rdf.sparql.update_authority_required',
          capability: 'sparql.update.authority',
        },
      );
    }
    return prepared;
  }

  private async executePreparedRdfSparqlUpdate(
    delta: RdfPreparedUpdateDelta,
    baseIri: string,
    accessScope?: RdfAccessScope,
  ): Promise<ResourceIdentifier[]> {
    const patches: LocalRdfAuthorityPatch[] = [];
    for (const graphDelta of delta.graphs) {
      if (graphDelta.graphIri !== graphDelta.sourceUri) {
        throw new UnsupportedSparqlQueryError(
          'Native prepared update v1 requires the graph IRI to equal its local RDF source URI',
        );
      }
      const serverOwnedBase = accessScope?.basePath ?? this.parentContainer({ path: baseIri }).path;
      if (!graphDelta.graphIri.startsWith(serverOwnedBase)) {
        throw new UnsupportedSparqlQueryError(
          'Native prepared update cannot write outside the server-owned Pod scope',
        );
      }
      if (accessScope && !rdfAccessGraphAllowed(graphDelta.graphIri, accessScope)) {
        throw new UnsupportedSparqlQueryError(
          'Native prepared update cannot write an RDF graph denied by the current access scope',
        );
      }
      const identifier = { path: graphDelta.sourceUri };
      if (!this.isByLineRdfIdentifier(identifier)) {
        throw new UnsupportedSparqlQueryError('Native prepared update only supports by-line local RDF graph documents');
      }
      const previous = await this.readLocalRdfState(identifier);
      const graph = DataFactory.namedNode(graphDelta.graphIri);
      const previousQuads = previous.text.length > 0
        ? await this.parseLocalRdf(identifier, previous.text, this.localRdfContentType(identifier))
          .then((items) => items.map((item) => this.toGraphQuad(item, graph)))
        : [];
      const next = new Map(previousQuads.map((item) => [this.quadKey(item), item]));
      for (const item of graphDelta.deletes) {
        this.assertPreparedDeltaQuadGraph(item, graphDelta.graphIri);
        next.delete(this.quadKey(item));
      }
      for (const item of graphDelta.inserts) {
        this.assertPreparedDeltaQuadGraph(item, graphDelta.graphIri);
        next.set(this.quadKey(item), item);
      }
      patches.push({
        identifier,
        previousQuads,
        previousExists: previous.existed,
        nextQuads: [...next.values()],
      });
    }
    await this.writeLocalRdfAuthorityPatches(patches);
    return patches.map((patch) => patch.identifier);
  }

  private assertPreparedDeltaQuadGraph(quad: Quad, graphIri: string): void {
    if (quad.graph.termType !== 'NamedNode' || quad.graph.value !== graphIri) {
      throw new UnsupportedSparqlQueryError(
        'Native prepared update contains a quad outside its declared writable graph',
      );
    }
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
    const journalPatches: LocalRdfAuthorityJournalPatch[] = [];
    const journalDrafts = await this.prepareLocalRdfAuthorityJournalPatches(patches);
    try {
      for (let index = 0; index < patches.length; index += 1) {
        const patch = patches[index];
        const authorityQuads = patch.nextQuads.map((quad) => this.toDefaultGraphQuad(quad));
        await this.writeLocalRdfAuthority(patch.identifier, authorityQuads);
        applied.push(patch);
        const operation = await this.recordLocalRdfAuthorityJournalPatch(journalDrafts[index]);
        if (operation) {
          journalPatches.push({ patch, operation });
        }
      }

      for (const patch of applied) {
        const authorityQuads = patch.nextQuads.map((quad) => this.toDefaultGraphQuad(quad));
        await this.writeStructuredRdfIndex(patch.identifier, authorityQuads, new RepresentationMetadata(patch.identifier));
        await this.syncTextSearchIndex(
          patch.identifier,
          await this.serializeQuadsForLocalFile(patch.identifier, authorityQuads),
          {},
          authorityQuads,
        );
      }

      for (const journalPatch of journalPatches) {
        await this.localRdfAuthorityJournal?.markDone(journalPatch.operation.id);
      }
    } catch (error) {
      await this.markLocalRdfAuthorityJournalFailure(journalPatches, error);
      const rollbackFailures = await this.rollbackLocalRdfAuthorityPatches(applied);
      if (rollbackFailures.length === 0) {
        await this.markLocalRdfAuthorityRollbackComplete(journalPatches, error);
      }
      throw error;
    }
  }

  private async prepareLocalRdfAuthorityJournalPatches(
    patches: LocalRdfAuthorityPatch[],
  ): Promise<LocalRdfAuthorityJournalPatchDraft[]> {
    if (!this.localRdfAuthorityJournal || !this.rdfFileMapper || patches.length === 0) {
      return [];
    }

    const mapped = await Promise.all(patches.map(async (patch) => ({
      patch,
      link: await this.rdfFileMapper!.mapUrlToFilePath(patch.identifier, false, this.localRdfContentType(patch.identifier)),
    })));
    const workspace = this.localRdfPatchWorkspace(
      mapped.map(({ patch }) => patch.identifier.path),
      mapped.map(({ link }) => link.filePath),
    );
    const txId = localRdfPatchTxId(workspace, mapped.map(({ patch, link }) => ({
      path: this.localRdfPatchRelativePath(patch.identifier.path, workspace.workspace, link.filePath, workspace.cwd),
      resource: patch.identifier.path,
      sourcePath: link.filePath,
      type: patch.previousExists ? 'updated' : 'created',
    })));

    return mapped.map(({ patch, link }): LocalRdfAuthorityJournalPatchDraft => ({
      patch,
      workspace,
      txId,
      change: {
        path: this.localRdfPatchRelativePath(patch.identifier.path, workspace.workspace, link.filePath, workspace.cwd),
        resource: patch.identifier.path,
        source: 'filesystem',
        sourcePath: link.filePath,
        contentType: this.localRdfContentType(patch.identifier),
        projection: 'direct',
        type: patch.previousExists ? 'updated' : 'created',
      },
    }));
  }

  private async recordLocalRdfAuthorityJournalPatch(
    draft: LocalRdfAuthorityJournalPatchDraft | undefined,
  ): Promise<LocalRdfAuthorityJournalOperation | undefined> {
    if (!draft || !this.localRdfAuthorityJournal) {
      return undefined;
    }
    return this.localRdfAuthorityJournal.recordLocalCommitted(draft.change, draft.workspace, draft.txId);
  }

  private async markLocalRdfAuthorityJournalFailure(
    journalPatches: LocalRdfAuthorityJournalPatch[],
    error: unknown,
  ): Promise<void> {
    if (!this.localRdfAuthorityJournal || journalPatches.length === 0) {
      return;
    }
    const message = `Local RDF authority patch did not complete; rollback/reconcile required: ${error instanceof Error ? error.message : String(error)}`;
    for (const journalPatch of journalPatches) {
      try {
        await this.localRdfAuthorityJournal.markRetryableFailure(journalPatch.operation.id, error);
        await this.localRdfAuthorityJournal.markReconcileRequired(journalPatch.operation.id, message);
      } catch (journalError) {
        this.logger.warn(`Failed to update local RDF authority journal for ${journalPatch.patch.identifier.path}: ${journalError instanceof Error ? journalError.message : String(journalError)}`);
      }
    }
  }

  private async markLocalRdfAuthorityRollbackComplete(
    journalPatches: LocalRdfAuthorityJournalPatch[],
    error: unknown,
  ): Promise<void> {
    if (!this.localRdfAuthorityJournal || journalPatches.length === 0) {
      return;
    }
    const message = `Local RDF authority patch failed and was rolled back: ${error instanceof Error ? error.message : String(error)}`;
    for (const journalPatch of journalPatches) {
      try {
        await this.localRdfAuthorityJournal.markFailedPermanent(journalPatch.operation.id, message);
      } catch (journalError) {
        this.logger.warn(`Failed to finalize rolled-back local RDF authority journal for ${journalPatch.patch.identifier.path}: ${journalError instanceof Error ? journalError.message : String(journalError)}`);
      }
    }
  }

  private localRdfPatchWorkspace(
    resourcePaths: string[],
    filePaths: string[],
  ): SolidFsManifest {
    const workspace = commonHttpContainer(resourcePaths) ?? this.parentContainer({ path: resourcePaths[0] }).path;
    const cwd = commonDirectory(filePaths);
    return {
      workspace,
      cwd,
      projection: 'direct',
      entries: [],
    };
  }

  private localRdfPatchRelativePath(
    identifierPath: string,
    workspace: string,
    filePath: string,
    cwd: string,
  ): string {
    const relative = this.relativePathFromWorkspace(identifierPath, workspace)
      ?? path.relative(cwd, filePath).split(path.sep).join('/');
    return relative && relative.length > 0 ? relative : path.basename(filePath);
  }

  private async rollbackLocalRdfAuthorityPatches(patches: LocalRdfAuthorityPatch[]): Promise<string[]> {
    const failures: string[] = [];
    for (const patch of patches.slice().reverse()) {
      try {
        if (patch.previousExists) {
          const authorityQuads = patch.previousQuads.map((quad) => this.toDefaultGraphQuad(quad));
          await this.writeLocalRdfAuthority(patch.identifier, authorityQuads);
          await this.writeStructuredRdfIndex(patch.identifier, authorityQuads, new RepresentationMetadata(patch.identifier));
          await this.syncTextSearchIndex(
            patch.identifier,
            await this.serializeQuadsForLocalFile(patch.identifier, authorityQuads),
            {},
            authorityQuads,
          );
        } else {
          await this.deleteRdfFileResourceIfPresent(patch.identifier);
          await this.deleteLocalRdfIndex(patch.identifier);
          await this.deleteSearchIndexes(patch.identifier);
        }
        this.invalidateMetadataCache(patch.identifier);
      } catch (rollbackError) {
        failures.push(`${patch.identifier.path}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
      }
    }
    if (failures.length > 0) {
      this.logger.warn(`Failed to fully roll back local RDF authority patch: ${failures.join('; ')}`);
    }
    return failures;
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
    await this.syncTextSearchIndex(identifier, text, {
      ...options,
      contentType: localContentType,
    }, quads);
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
      await this.deleteSearchIndexes(identifier);
      this.invalidateMetadataCache(identifier);
    } catch (error) {
      if (!NotFoundHttpError.isInstance(error)) {
        throw error;
      }
    }
  }

  public async moveLocalRdfIndex(
    previousIdentifier: ResourceIdentifier,
    nextIdentifier: ResourceIdentifier,
    options: LocalRdfMoveOptions = {},
  ): Promise<number> {
    const sourceScopedAccessor = this.sourceScopedStructuredAccessor();
    if (!sourceScopedAccessor?.moveRdfSourceDocument) {
      return 0;
    }

    const moved = await sourceScopedAccessor.moveRdfSourceDocument(
      options.previousSource ?? previousIdentifier.path,
      this.rdfSourceInput(nextIdentifier, options),
    );
    if (moved > 0) {
      await this.moveSearchIndexes(previousIdentifier, nextIdentifier, options, sourceScopedAccessor);
      this.invalidateMetadataCache(previousIdentifier);
      this.invalidateMetadataCache(nextIdentifier);
    }
    return moved;
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
    const text = await this.serializeQuadsForLocalFile(identifier, quads);

    await this.rdfFileDataAccessor.writeDocument(
      identifier,
      guardStream(Readable.from([ text ])),
      this.createLocalRdfMetadata(identifier, metadata),
    );

    try {
      await this.writeStructuredRdfIndex(identifier, quads, structuredMetadata);
      await this.syncTextSearchIndex(identifier, text, {}, quads);
    } catch (error) {
      await this.deleteRdfFileResourceIfPresent(identifier);
      await this.deleteSearchIndexes(identifier);
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
    const text = await this.serializeQuadsForLocalFile(identifier, quads);
    await this.rdfFileDataAccessor.writeDocument(
      identifier,
      guardStream(Readable.from([ text ])),
      this.createLocalRdfMetadata(identifier, metadata),
    );
    await this.syncTextSearchIndex(identifier, text, {}, quads);
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

  private async syncTextSearchIndex(
    identifier: ResourceIdentifier,
    text: string,
    options: LocalRdfSyncOptions & { contentType?: string } = {},
    quads?: Quad[],
  ): Promise<void> {
    if (!this.textSearchIndexingEnabled || !this.isByLineRdfIdentifier(identifier)) {
      return;
    }
    const accessor = this.sourceScopedStructuredAccessor();
    if (!accessor?.indexTextSource) {
      return;
    }
    await this.deleteVectorIndexIfPresent(accessor, identifier);
    const source = this.rdfTextSourceInput(identifier, text, options);
    await accessor.indexTextSource(
      source,
      text,
      quads ? createRdfEntityTextChunks(source, quads) : undefined,
    );
    await this.rdfSearchIntentSink?.recordTextCommitted(source);
  }

  private async syncUnstructuredTextSearchIndex(
    identifier: ResourceIdentifier,
    text: string,
    metadata: RepresentationMetadata,
  ): Promise<void> {
    if (!this.textSearchIndexingEnabled || !this.isSearchableUnstructuredText(identifier, metadata)) {
      return;
    }
    const accessor = this.sourceScopedStructuredAccessor();
    if (!accessor?.indexTextSource) {
      return;
    }
    await this.deleteVectorIndexIfPresent(accessor, identifier);
    const source = this.rdfTextSourceInput(identifier, text, { contentType: metadata.contentType });
    await accessor.indexTextSource(
      source,
      text,
    );
    await this.rdfSearchIntentSink?.recordTextCommitted(source);
  }

  private async deleteSearchIndexes(identifier: ResourceIdentifier): Promise<void> {
    if (!this.textSearchIndexingEnabled) {
      return;
    }
    const accessor = this.sourceScopedStructuredAccessor();
    await accessor?.deleteTextSource?.(identifier.path);
    if (accessor) {
      await this.deleteVectorIndexIfPresent(accessor, identifier);
    }
    await this.rdfSearchIntentSink?.recordSourceDeleted(identifier.path);
  }

  private async moveSearchIndexes(
    previousIdentifier: ResourceIdentifier,
    nextIdentifier: ResourceIdentifier,
    options: LocalRdfMoveOptions,
    accessor: SourceScopedStructuredRdfAccessor,
  ): Promise<void> {
    if (!this.textSearchIndexingEnabled || !this.isByLineRdfIdentifier(nextIdentifier)) {
      return;
    }
    const previousSource = options.previousSource ?? previousIdentifier.path;
    const nextSource = this.rdfSourceInput(nextIdentifier, options);
    let movedText = 0;
    if (accessor.moveTextSource) {
      movedText = await accessor.moveTextSource(previousSource, nextSource);
    }
    await this.moveVectorIndexIfPresent(accessor, previousSource, nextSource);
    if (movedText > 0) {
      await this.rdfSearchIntentSink?.recordTextCommitted(nextSource);
    }
  }

  private async moveVectorIndexIfPresent(
    accessor: SourceScopedStructuredRdfAccessor,
    previousSource: string,
    nextSource: RdfVectorSourceInput,
  ): Promise<number> {
    try {
      return await accessor.moveVectorSource?.(previousSource, nextSource) ?? 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/vector index is not configured/i.test(message)) {
        throw error;
      }
      return 0;
    }
  }

  private async deleteVectorIndexIfPresent(
    accessor: SourceScopedStructuredRdfAccessor,
    identifier: ResourceIdentifier,
  ): Promise<void> {
    try {
      await accessor.deleteVectorSource?.(identifier.path);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/vector index is not configured/i.test(message)) {
        throw error;
      }
    }
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

  private rdfTextSourceInput(
    identifier: ResourceIdentifier,
    text: string,
    options: LocalRdfSyncOptions & { contentType?: string },
  ): RdfTextSourceInput {
    return {
      ...this.rdfSourceInput(identifier, options),
      sourceHash: `sha256:${createHash('sha256').update(text).digest('hex')}`,
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

  private isSearchableUnstructuredText(
    identifier: ResourceIdentifier,
    metadata: RepresentationMetadata,
  ): boolean {
    const contentType = normalizeContentType(metadata.contentType);
    if (contentType === 'text/plain' || contentType === 'text/markdown' || contentType === 'text/x-markdown') {
      return true;
    }
    const pathname = (() => {
      try {
        return new URL(identifier.path).pathname;
      } catch {
        return identifier.path;
      }
    })().toLowerCase();
    return pathname.endsWith('.md') || pathname.endsWith('.markdown') || pathname.endsWith('.mdown');
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
    const indexableText = this.textSearchIndexingEnabled && this.isSearchableUnstructuredText(identifier, metadata)
      ? await this.readStreamText(data)
      : undefined;
    const writeData = indexableText === undefined ? data : guardStream(Readable.from([ indexableText ]));

    // Write the actual data to unstructured storage
    await this.unstructuredDataAccessor.writeDocument(identifier, writeData, metadata);
    
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
      if (indexableText !== undefined) {
        await this.syncUnstructuredTextSearchIndex(identifier, indexableText, updatedMetadata);
      }
    } catch (error) {
      this.logger.error(`Error writing metadata for ${identifier.path}: ${error}`);
      // Rollback: delete the unstructured data
      await this.unstructuredDataAccessor.deleteResource(identifier);
      if (indexableText !== undefined) {
        await this.deleteSearchIndexes(identifier);
      }
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

function localRdfPatchTxId(
  manifest: SolidFsManifest,
  changes: Array<Pick<SolidFsChange, 'path' | 'resource' | 'sourcePath' | 'type'>>,
): string | undefined {
  if (changes.length <= 1) {
    return undefined;
  }

  const digest = createHash('sha256')
    .update(JSON.stringify({
      workspace: manifest.workspace,
      projection: manifest.projection,
      cwd: manifest.cwd,
      changes,
      nonce: randomUUID(),
    }))
    .digest('hex')
    .slice(0, 32);
  return `solidfs_tx_${digest}`;
}

function commonHttpContainer(resourcePaths: string[]): string | undefined {
  const urls: URL[] = [];
  for (const resourcePath of resourcePaths) {
    try {
      const url = new URL(resourcePath);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return undefined;
      }
      url.hash = '';
      url.search = '';
      urls.push(url);
    } catch {
      return undefined;
    }
  }
  if (urls.length === 0) {
    return undefined;
  }
  const origin = urls[0].origin;
  if (!urls.every((url) => url.origin === origin)) {
    return undefined;
  }

  const parentSegments = urls.map((url) => {
    const parts = url.pathname.replace(/\/+$/u, '').split('/').filter(Boolean);
    parts.pop();
    return parts;
  });
  const common: string[] = [];
  const first = parentSegments[0];
  for (let index = 0; index < first.length; index += 1) {
    const value = first[index];
    if (!parentSegments.every((segments) => segments[index] === value)) {
      break;
    }
    common.push(value);
  }

  const workspace = new URL(urls[0].href);
  workspace.pathname = `/${common.join('/')}${common.length > 0 ? '/' : ''}`;
  workspace.hash = '';
  workspace.search = '';
  return workspace.href;
}

function commonDirectory(filePaths: string[]): string {
  if (filePaths.length === 0) {
    return process.cwd();
  }
  const directories = filePaths.map((filePath) => path.resolve(path.dirname(filePath)).split(path.sep));
  const first = directories[0];
  const common: string[] = [];
  for (let index = 0; index < first.length; index += 1) {
    const value = first[index];
    if (!directories.every((segments) => segments[index] === value)) {
      break;
    }
    common.push(value);
  }
  const joined = common.join(path.sep);
  return joined.length > 0 ? joined : path.parse(path.resolve(filePaths[0])).root;
}
