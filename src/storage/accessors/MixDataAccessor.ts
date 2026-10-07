import type { LocalPhysicalOperationService } from '../LocalPhysicalOperationService';
import { deliverPhysicalResult, iteratePhysicalResult, observePhysicalStream, runPhysicalOperation } from '../LocalPhysicalStreamLifetime';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
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
  isRdfDocumentContentType,
  isRdfDocumentPath,
  normalizeContentType,
  rdfContentTypeForPath,
} from '../rdf/RdfContentTypes';
import { createRdfEntityTextChunks } from '../rdf/RdfTextProjection';
import { serializeRdfXml } from '../rdf/RdfXmlSerializer';
import { rdfAccessGraphAllowed, type RdfAccessScope } from '../rdf/RdfAccessScope';
import {
  clearDocumentVersion,
  computeDocumentVersion,
  writeDocumentVersion,
} from '../rdf/DocumentVersion';
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
import { assertCurrentLockOwnership, currentLockCancellationSignal } from '../locking/LockExecutionContext';
import { captureAuthorityDependency } from '../AuthoritySnapshotContext';
import { authorityResourceTracker } from '../AuthorityResourceTracker';
import type { SparqlVoidOptions } from '../sparql/SubgraphQueryEngine';
import type { SolidFsChange, SolidFsManifest } from '../../solidfs/types';
import {
  AuthorityFreshnessService,
  AuthorityPendingFreshnessProvider,
  AuthorityPendingUnavailableError,
  hashAuthoritySource,
  type AuthorityFreshnessBackend,
  type AuthorityFreshnessProvider,
} from '../AuthorityFreshnessService';

interface AuthorityFreshnessAttachable {
  setAuthorityFreshnessProvider?(provider: AuthorityFreshnessProvider): void;
}
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
  /** Internal recovery reads an already retained authority file and rebuilds derived state only. */
  retainedAuthorityFile?: boolean;
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
  change?: SolidFsChange;
  afterHash?: string;
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
  /** Optional pre-write pending bookkeeping used by the authority freshness contract. */
  recordAuthorityPending?(
    change: SolidFsChange,
    workspace: SolidFsManifest,
    sourceVersion: string,
    txId?: string,
  ): LocalRdfAuthorityJournalOperation;
  attachAuthorityPendingHash?(id: string, afterHash: string): void;
  clearAuthorityPending?(id: string): boolean;
  listAuthorityPending?(path?: string): LocalRdfAuthorityJournalOperation[];
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
    private readonly operationService?: LocalPhysicalOperationService,
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
    // The configured authority journal is the single source of derived-index freshness. Wire it into
    // the structured engine so native/conditional reads observe the same state as ordinary Mix reads.
    if (
      localRdfAuthorityJournal
      && typeof (localRdfAuthorityJournal as Partial<AuthorityFreshnessBackend>).listAuthorityPending === 'function'
    ) {
      const freshness = new AuthorityFreshnessService(localRdfAuthorityJournal as unknown as AuthorityFreshnessBackend);
      (structuredDataAccessor as AuthorityFreshnessAttachable)
        .setAuthorityFreshnessProvider?.(new AuthorityPendingFreshnessProvider(freshness));
    }
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
    return deliverPhysicalResult(this.operationService, async () => {
      captureAuthorityDependency(identifier.path, identifier.path);
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
    }, value => observePhysicalStream(value));
  }

  /**
   * Read the local RDF file mirror used by SolidFS/local-first HTTP reads.
   *
   * `getData()` intentionally keeps returning the structured quad stream for
   * CSS internals. This method is the explicit file-content path for callers
   * that need a real Turtle/JSON-LD byte stream.
   */
  public async getLocalRdfDocument(identifier: ResourceIdentifier): Promise<LocalRdfDocument> {
    return deliverPhysicalResult(this.operationService, async () => {
      if (isContainerIdentifier(identifier)) {
        throw new NotFoundHttpError();
      }

      if (this.isByLineRdfIdentifier(identifier)) {
        try {
          const document: LocalRdfDocument = {
            data: await this.rdfFileDataAccessor.getData(identifier),
            metadata: await this.getExistingLocalRdfMetadata(identifier),
          };
          return await this.qualifyLocalRdfDocument(identifier, document);
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
        const document: LocalRdfDocument = {
          data: await this.rdfFileDataAccessor.getData(identifier),
          metadata: await this.getLocalRdfMetadata(identifier, metadata),
        };
        return await this.qualifyLocalRdfDocument(identifier, document);
      } catch (error) {
        if (!NotFoundHttpError.isInstance(error)) {
          throw error;
        }
      }

      await this.refreshLocalRdfMirror(identifier);

      return await this.qualifyLocalRdfDocument(identifier, {
        data: await this.rdfFileDataAccessor.getData(identifier),
        metadata: await this.getLocalRdfMetadata(identifier, metadata),
      });
    }, value => observePhysicalStream(value.data));
  }

  public async getMetadata(identifier: ResourceIdentifier): Promise<RepresentationMetadata> {
    const execute = async () => {
      // Capture the authority dependency before any memo/cache/404 so a warm hit cannot hide a
      // concurrent ACL/ACR mutation during an authorization attempt.
      captureAuthorityDependency(identifier.path, identifier.path);
      await this.ensureDerivedFactsFresh(identifier);
      const cache = metadataRequestContext.getStore()?.metadataCache;
      const cacheKey = identifier.path;
      const cached = cache?.get(cacheKey);
      if (cached) {
        if (cached.kind === 'miss') {
          throw new NotFoundHttpError();
        }
        return await this.attachDocumentVersion(identifier, new RepresentationMetadata(cached.metadata));
      }

      try {
        const metadata = await this.structuredDataAccessor.getMetadata(identifier);

        if (!metadata.contentType) {
          metadata.contentType = INTERNAL_QUADS;
        }

        cache?.set(cacheKey, { kind: 'hit', metadata: new RepresentationMetadata(metadata) });
        return await this.attachDocumentVersion(identifier, metadata);
      } catch (error) {
        if (NotFoundHttpError.isInstance(error)) {
          cache?.set(cacheKey, { kind: 'miss' });
        }
        throw error;
      }
    };
    return this.operationService ? this.operationService.run(execute) : execute();
  }

  public async* getChildren(identifier: ResourceIdentifier): AsyncIterableIterator<RepresentationMetadata> {
    const source = async function* (this: MixDataAccessor) {
      // A pending source anywhere in this container's subtree may hide a child; rebuild the affected
      // retained files or refuse rather than return a possibly stale or incomplete listing.
      await this.ensureDerivedFactsFresh(identifier, { subtree: true });
      // Children metadata is stored in the structured accessor
      yield* this.structuredDataAccessor.getChildren(identifier);
    };
    yield* iteratePhysicalResult(this.operationService, () => source.call(this));
  }

  /**
   * Generic derived-index freshness check. If the exact-source pending token for this resource is
   * still present, rebuild the derived facts from the complete authority file; on success clear the
   * exact token; on failure report explicit retryable unavailability (never a false 404).
   */
  private async ensureDerivedFactsFresh(
    identifier: ResourceIdentifier,
    options: { subtree?: boolean } = {},
  ): Promise<void> {
    const journal = this.localRdfAuthorityJournal;
    const list = journal?.listAuthorityPending;
    if (!journal || typeof list !== 'function') {
      return;
    }
    const scope = identifier.path;
    const descendantPrefix = scope.endsWith('/') ? scope : `${scope}/`;
    const pending = list.call(journal).filter((op) => {
      const resource = op.change?.resource;
      if (resource === scope || op.change?.path === scope) {
        return true;
      }
      // A container listing must observe pending descendants, not just an exact-resource token.
      return Boolean(options.subtree && typeof resource === 'string' && resource.startsWith(descendantPrefix));
    });
    if (pending.length === 0) {
      return;
    }
    for (const op of pending) {
      const target = op.change?.resource ?? op.change?.path;
      if (typeof target !== 'string' || target.length === 0) {
        continue;
      }
      try {
        await this.rebuildDerivedFromAuthorityFile({ path: target });
        journal.attachAuthorityPendingHash?.(op.id, '');
        journal.clearAuthorityPending?.(op.id);
      } catch (error) {
        // Reference only the requested scope; never leak unrelated pending resource paths.
        this.logger.warn(`Derived facts still pending for a requested read scope: ${String(error)}`);
        throw new AuthorityPendingUnavailableError(
          `Derived facts for ${scope} are pending against the authority file and could not be rebuilt`,
        );
      }
    }
  }

  /**
   * Rebuild derived facts from the actual complete authority file. Never reverse-repairs the file
   * from an old index/payload.
   */
  private async rebuildDerivedFromAuthorityFile(identifier: ResourceIdentifier): Promise<void> {
    const source = await this.rdfFileDataAccessor.getData(identifier);
    const text = await this.readStreamText(source);
    const contentType = this.localRdfContentType(identifier);
    const quads = await this.parseLocalRdf(identifier, text, contentType);
    await this.writeStructuredRdfIndex(identifier, quads, new RepresentationMetadata(identifier), { contentType });
    if (this.textSearchIndexingEnabled) {
      await this.syncTextSearchIndex(identifier, text, { contentType }, quads);
    }
    this.invalidateMetadataCache(identifier);
  }

  public async writeContainer(
    identifier: ResourceIdentifier,
    metadata: RepresentationMetadata,
  ): Promise<void> {
    const execute = async () => {
      await assertCurrentLockOwnership();
      // The lock is held (asserted above); only now is this an actual authority mutation.
      await authorityResourceTracker.runMutation(identifier.path, async() => {
        if (this.mirrorContainersToUnstructured && this.isUnstructured(metadata)) {
          await this.unstructuredDataAccessor.writeContainer(identifier, metadata);
        }
        await this.structuredDataAccessor.writeContainer(identifier, metadata);
        this.invalidateMetadataCache(identifier);
      });
    };
    return this.operationService ? this.operationService.run(execute) : execute();
  }

  public async writeDocument(
    identifier: ResourceIdentifier,
    data: Guarded<Readable>,
    metadata: RepresentationMetadata,
  ): Promise<void> {
    const execute = async () => {
      await authorityResourceTracker.runMutation(identifier.path, async() => {
        if (this.isUnstructured(metadata)) {
          await this.writeUnstructuredDocument(identifier, data, metadata);
          this.invalidateMetadataCache(identifier);
          return;
        }
        await this.writeRdfDocument(identifier, data, metadata);
        this.invalidateMetadataCache(identifier);
      });
    };
    return runPhysicalOperation(this.operationService, execute, data);
  }

  public async writeMetadata(identifier: ResourceIdentifier, metadata: RepresentationMetadata): Promise<void> {
    const execute = async () => {
      // Metadata always goes to structured storage
      await assertCurrentLockOwnership();
      await authorityResourceTracker.runMutation(identifier.path, async() => {
        await this.structuredDataAccessor.writeMetadata(identifier, metadata);
        this.invalidateMetadataCache(identifier);
      });
    };
    return this.operationService ? this.operationService.run(execute) : execute();
  }

  public async deleteResource(identifier: ResourceIdentifier): Promise<void> {
    const execute = async () => {
      const metadata = await this.getMetadata(identifier);
      await assertCurrentLockOwnership();
      await authorityResourceTracker.runMutation(identifier.path, async() => {
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
      });
    };
    return this.operationService ? this.operationService.run(execute) : execute();
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
    const execute = async () => {
      if (!baseIri) {
        throw new UnsupportedSparqlQueryError(
          'Pod SPARQL UPDATE requires a server-owned base IRI',
          { code: 'rdf.sparql.update_authority_required' },
        );
      }
      // Register the mutation only once the server-owned base IRI is known and the caller's scope
      // lock is held; preparation, persist and rollback all settle inside this boundary. The directory
      // fence is intentionally preserved; the exact-resource fence inside
      // `writeLocalRdfAuthorityPatches` additionally invalidates only the resources this delta writes.
      await authorityResourceTracker.runMutation(baseIri, async() => {
        const prepared = await this.prepareNativeRdfSparqlUpdate(query, baseIri, accessScope, options);
        const writtenIdentifiers = await this.executePreparedRdfSparqlUpdate(
          prepared,
          baseIri,
          accessScope,
        );
        for (const writtenIdentifier of writtenIdentifiers) {
          this.invalidateMetadataCache(writtenIdentifier);
        }
      });
    };
    return this.operationService ? this.operationService.run(execute) : execute();
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
    await assertCurrentLockOwnership();
    const leaseSignal = currentLockCancellationSignal();
    const signal = leaseSignal && options?.signal
      ? AbortSignal.any([ leaseSignal, options.signal ])
      : leaseSignal ?? options?.signal;
    const prepareOptions = options || signal
      ? {
          ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
          ...(signal ? { signal } : {}),
        }
      : undefined;
    const prepared = await accessor.prepareSparqlUpdate(query, baseIri, accessScope, prepareOptions);
    await assertCurrentLockOwnership();
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

  private async writeLocalRdfAuthority(
    identifier: ResourceIdentifier,
    quads: Quad[],
    verifyLockOwnership = false,
  ): Promise<void> {
    // Rollback must finish under the still-held local lock even after lease loss.
    if (verifyLockOwnership) await assertCurrentLockOwnership();
    await this.ensureRdfFileParentContainers(identifier);
    const text = await this.serializeQuadsForLocalFile(identifier, quads);
    if (verifyLockOwnership) await assertCurrentLockOwnership();
    await this.rdfFileDataAccessor.writeDocument(
      identifier,
      guardStream(Readable.from([ text ])),
      this.createLocalRdfMetadata(identifier, new RepresentationMetadata(identifier)),
    );
  }

  private async writeLocalRdfAuthorityPatches(patches: LocalRdfAuthorityPatch[]): Promise<void> {
    await assertCurrentLockOwnership();
    // Invalidate exactly the resources this prepared delta actually writes — never the `baseIri`
    // directory. A snapshot of the changed ACL/ACR must observe `active:true` from before the first
    // file/index mutation until rollback settles, so a concurrent authorization cannot commit a
    // stale decision. Deduplicate: one resource written by several graph deltas is one authority.
    const changedResources = [ ...new Set(patches.map((patch) => patch.identifier.path)) ];
    for (const resource of changedResources) {
      authorityResourceTracker.beginMutation(resource);
    }
    try {
      const applied: LocalRdfAuthorityPatch[] = [];
      const journalPatches: LocalRdfAuthorityJournalPatch[] = [];
      const journalDrafts = await this.prepareLocalRdfAuthorityJournalPatches(patches);
      try {
        for (let index = 0; index < patches.length; index += 1) {
          const patch = patches[index];
          const authorityQuads = patch.nextQuads.map((quad) => this.toDefaultGraphQuad(quad));
          await this.writeLocalRdfAuthority(patch.identifier, authorityQuads, true);
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
    } finally {
      // Settle the exact resources only after the file/index writes, journal bookkeeping and any
      // rollback have all finished, so neither the committed state nor a rolled-back state is ever
      // observed as a fresh authority mid-flight.
      for (const resource of changedResources) {
        authorityResourceTracker.endMutation(resource);
      }
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
    const execute = async () => {
      // CSS maps Turtle files such as profile/card$.ttl to extensionless URLs.
      // Recovery already supplies the authority file's RDF content type.
      if (!isRdfDocumentContentType(contentType) && !this.isRdfDocumentIdentifier(identifier)) {
        throw new Error(`Cannot sync non RDF document into RDF index: ${identifier.path}`);
      }

      const source = data ?? await this.rdfFileDataAccessor.getData(identifier);
      const localContentType = contentType ?? this.localRdfContentType(identifier);
      const text = await this.readStreamText(source);
      if (data && !options?.retainedAuthorityFile) {
        await this.ensureRdfFileParentContainers(identifier);
        const localMetadata = this.createLocalRdfMetadata(identifier, new RepresentationMetadata(identifier));
        localMetadata.contentType = localContentType;
        await this.rdfFileDataAccessor.writeDocument(
          identifier,
          guardStream(Readable.from([ text ])),
          localMetadata,
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
    };
    return runPhysicalOperation(this.operationService, execute, data);
  }

  public async deleteLocalRdfIndex(identifier: ResourceIdentifier): Promise<void> {
    const execute = async () => {
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
    };
    return this.operationService ? this.operationService.run(execute) : execute();
  }

  public async moveLocalRdfIndex(
    previousIdentifier: ResourceIdentifier,
    nextIdentifier: ResourceIdentifier,
    options: LocalRdfMoveOptions = {},
  ): Promise<number> {
    const execute = async () => {
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
    };
    return this.operationService ? this.operationService.run(execute) : execute();
  }

  private async writeRdfDocument(
    identifier: ResourceIdentifier,
    data: Guarded<Readable>,
    metadata: RepresentationMetadata,
  ): Promise<void> {
    const quads = await arrayifyStream<Quad>(data);
    await assertCurrentLockOwnership();
    const structuredMetadata = new RepresentationMetadata(metadata);
    addResourceMetadata(structuredMetadata, false);
    updateModifiedDate(structuredMetadata);
    await this.ensureRdfFileParentContainers(identifier);
    const text = await this.serializeQuadsForLocalFile(identifier, quads);

    await assertCurrentLockOwnership();
    // Persist a fresh exact-source pending token BEFORE any authority change. If persistence
    // fails, no file change is attempted. Pending means the derived index may be stale; it is
    // not a commit receipt.
    const pending = await this.recordAuthorityPendingBeforeWrite(identifier, text);

    await this.rdfFileDataAccessor.writeDocument(
      identifier,
      guardStream(Readable.from([ text ])),
      this.createLocalRdfMetadata(identifier, metadata),
    );

    try {
      await this.writeStructuredRdfIndex(identifier, quads, structuredMetadata);
      await this.syncTextSearchIndex(identifier, text, {}, quads);
      // All required derived stages succeeded and the retained bytes still match the intended
      // source: clear exactly this pending token.
      this.clearAuthorityPendingAfterSuccess(pending, text);
    } catch (error) {
      // Preserve the complete authority bytes and retain pending. Invalidate the request cache on
      // failure, and never erase authority or hide the derived failure. Ancillary bookkeeping must
      // not obscure the original mutation error.
      this.invalidateMetadataCache(identifier);
      try {
        await this.deleteSearchIndexes(identifier);
      } catch (ancillary) {
        this.logger.warn(
          `Post-write index cleanup failed for ${identifier.path}: ${String(ancillary)}; original authority error retained`,
        );
      }
      throw error;
    }
  }

  private async recordAuthorityPendingBeforeWrite(
    identifier: ResourceIdentifier,
    text: string,
  ): Promise<LocalRdfAuthorityJournalOperation | undefined> {
    const journal = this.localRdfAuthorityJournal;
    if (!journal?.recordAuthorityPending) {
      return undefined;
    }
    const sourcePath = this.rdfFileMapper
      ? (await this.rdfFileMapper.mapUrlToFilePath(identifier, false, this.localRdfContentType(identifier))).filePath
      : identifier.path;
    // Reuse the existing journal/SolidFsPathUtils contract: `change.path` is the physical-relative
    // path under the workspace cwd, `sourcePath` is the absolute physical file, `resource` is the
    // resource IRI, and the workspace carries the authoritative HTTP container + physical cwd.
    const workspace = this.localRdfPatchWorkspace([ identifier.path ], [ sourcePath ]);
    return journal.recordAuthorityPending(
      {
        path: this.localRdfPatchRelativePath(identifier.path, workspace.workspace, sourcePath, workspace.cwd),
        resource: identifier.path,
        sourcePath,
        source: 'filesystem',
        projection: 'direct',
        contentType: this.localRdfContentType(identifier),
        type: 'updated',
      },
      workspace,
      hashAuthoritySource(text),
    );
  }

  private clearAuthorityPendingAfterSuccess(
    pending: LocalRdfAuthorityJournalOperation | undefined,
    text: string,
  ): void {
    const journal = this.localRdfAuthorityJournal;
    if (!pending || !journal?.clearAuthorityPending) {
      return;
    }
    if (journal.attachAuthorityPendingHash) {
      journal.attachAuthorityPendingHash(pending.id, hashAuthoritySource(text));
    }
    journal.clearAuthorityPending(pending.id);
  }

  private async writeStructuredRdfIndex(
    identifier: ResourceIdentifier,
    quads: Quad[],
    metadata: RepresentationMetadata,
    options: LocalRdfSyncOptions & { contentType?: string } = {},
  ): Promise<void> {
    // Native prepared inserts bypass CSS's usual parent-container creation.
    // Container GET and containment use the structured accessor, not the file mirror.
    await this.ensureParentContainers(identifier, this.structuredDataAccessor);
    const structuredMetadata = new RepresentationMetadata(metadata);
    // The authority-derived version marker is a read-time validator, never persisted state. A
    // read-modify-write (for example a PATCH that reuses read metadata) must not store the sealed
    // marker into derived index metadata.
    clearDocumentVersion(structuredMetadata);
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
    // Never persist the internal authority-version marker (predicate and seal) into the local
    // authority sidecar. A read-modify-write can hand us read metadata that carries a genuine
    // sealed token; the token is recomputed from the authority bytes on every read instead.
    clearDocumentVersion(localMetadata);
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

  /**
   * Buffer small documents for an exact in-memory replay; above this the read path digests the
   * authority file with a bounded stream and keeps the untouched file-backed producer as the
   * replay. This is a memory bound, never a qualification cliff: large ordinary reads keep
   * working and stay qualified instead of silently regressing to seconds validators.
   */
  private static readonly DOCUMENT_VERSION_BUFFER_MAX_BYTES = 16 * 1024 * 1024;
  private static readonly DOCUMENT_VERSION_SIDECAR_MAX_BYTES = 4 * 1024 * 1024;

  /**
   * Eligible scope of the qualified document-version lane: a local file-authoritative
   * RDF document whose complete Turtle bytes are the delivered representation. Anything
   * else (containers, other MIME types, non-mirrored resources, oversized documents)
   * stays unqualified and keeps the original CSS validator.
   */
  private isQualifiedLocalDocument(
    identifier: ResourceIdentifier,
    metadata: RepresentationMetadata,
  ): boolean {
    if (isContainerIdentifier(identifier)) {
      return false;
    }
    if (!this.isLocalMirroredRdf(identifier, metadata)) {
      return false;
    }
    return normalizeContentType(this.localRdfContentType(identifier)) === 'text/turtle';
  }

  /**
   * Resolve the authority file path. An eligible document whose file cannot be mapped is an
   * authority-capture failure and must propagate, never silently drop qualification.
   */
  private async localRdfAuthorityFilePath(identifier: ResourceIdentifier): Promise<string | undefined> {
    if (!this.rdfFileMapper) {
      return undefined;
    }
    const mapped = await this.rdfFileMapper.mapUrlToFilePath(
      identifier,
      false,
      this.localRdfContentType(identifier),
    );
    return mapped.filePath;
  }

  /** Resolve the FileDataAccessor metadata sidecar that carries relevant authoritative metadata. */
  private async localRdfAuthoritySidecarPath(identifier: ResourceIdentifier): Promise<string | undefined> {
    if (!this.rdfFileMapper) {
      return undefined;
    }
    const mapped = await this.rdfFileMapper.mapUrlToFilePath(
      identifier,
      true,
      this.localRdfContentType(identifier),
    );
    return mapped.filePath;
  }

  /**
   * Read the relevant authoritative sidecar bytes under the same physical boundary. A missing
   * sidecar is legal (no extra state), an unreadable or oversized one is not.
   */
  private async readAuthoritySidecar(identifier: ResourceIdentifier): Promise<Uint8Array | undefined> {
    const sidecarPath = await this.localRdfAuthoritySidecarPath(identifier);
    if (!sidecarPath) {
      return undefined;
    }
    let info;
    try {
      info = await stat(sidecarPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      throw error;
    }
    if (!info.isFile()) {
      return undefined;
    }
    if (info.size > MixDataAccessor.DOCUMENT_VERSION_SIDECAR_MAX_BYTES) {
      throw new Error(`Local RDF authority sidecar for ${identifier.path} exceeds the bounded capture limit`);
    }
    return await readFile(sidecarPath);
  }

  /** Bounded sha256 over the authority bytes; never buffers the whole document. */
  private async digestAuthorityFile(filePath: string): Promise<string> {
    const hash = createHash('sha256');
    const source = createReadStream(filePath, { highWaterMark: 64 * 1024 });
    try {
      for await (const chunk of source) {
        hash.update(chunk as Buffer);
      }
      return hash.digest('hex');
    } finally {
      if (!source.destroyed) {
        source.destroy();
      }
    }
  }

  /**
   * One trusted encoder input: authority path + representation identity + protected body digest +
   * relevant sidecar digest. No index/tracker freshness and no client marker participates.
   */
  private async buildLocalDocumentVersion(
    identifier: ResourceIdentifier,
    metadata: RepresentationMetadata,
    body: { bytes: Uint8Array } | { digest: string },
  ): Promise<string> {
    const sidecar = await this.readAuthoritySidecar(identifier);
    const base = {
      resourcePath: this.documentVersionResourcePath(identifier, metadata),
      representationId: this.localRdfContentType(identifier),
      ...(sidecar ? { sidecar } : {}),
    };
    return 'bytes' in body
      ? computeDocumentVersion({ ...base, body: body.bytes })
      : computeDocumentVersion({ ...base, bodyDigest: body.digest });
  }

  private documentVersionResourcePath(identifier: ResourceIdentifier, metadata: RepresentationMetadata): string {
    return metadata.identifier.value || identifier.path;
  }

  /**
   * Attach the authority-derived document version to an eligible local document so the
   * synchronous CSS ETag path (GET/HEAD response metadata and write conditions) can use one
   * protected state. Recomputes from the current physical bytes on every call, so a warm
   * metadata cache can never revive a stale token. Eligible capture failure propagates;
   * absent or ineligible documents stay unqualified.
   */
  private async attachDocumentVersion(
    identifier: ResourceIdentifier,
    metadata: RepresentationMetadata,
  ): Promise<RepresentationMetadata> {
    if (!this.isQualifiedLocalDocument(identifier, metadata)) {
      return metadata;
    }
    const filePath = await this.localRdfAuthorityFilePath(identifier);
    if (!filePath) {
      throw new Error(`Local RDF authority file mapping failed for ${identifier.path}`);
    }
    let info;
    try {
      info = await stat(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return metadata;
      }
      throw error;
    }
    if (!info.isFile()) {
      return metadata;
    }
    const digest = await this.digestAuthorityFile(filePath);
    const token = await this.buildLocalDocumentVersion(identifier, metadata, { digest });
    writeDocumentVersion(metadata, token, this.documentVersionResourcePath(identifier, metadata));
    return metadata;
  }

  /**
   * Bind the delivered representation to one authority-derived version under the existing
   * operation boundary.
   *
   * Small documents are buffered for an exact in-memory replay. Larger documents are digested
   * with a bounded stream and the untouched file-backed producer is delivered as the replay, so
   * large ordinary reads keep working with bounded memory and are still qualified. The original
   * producer is registered before consumption and its real close is awaited before any buffered
   * replay is handed off, so admission never drains between materialization and replay.
   */
  private async qualifyLocalRdfDocument(
    identifier: ResourceIdentifier,
    document: LocalRdfDocument,
  ): Promise<LocalRdfDocument> {
    if (!this.isQualifiedLocalDocument(identifier, document.metadata)) {
      return document;
    }
    const filePath = await this.localRdfAuthorityFilePath(identifier);
    if (!filePath) {
      throw new Error(`Local RDF authority file mapping failed for ${identifier.path}`);
    }
    const info = await stat(filePath);
    if (!info.isFile()) {
      throw new NotFoundHttpError();
    }

    if (info.size > MixDataAccessor.DOCUMENT_VERSION_BUFFER_MAX_BYTES) {
      const digest = await this.digestAuthorityFile(filePath);
      const token = await this.buildLocalDocumentVersion(identifier, document.metadata, { digest });
      writeDocumentVersion(document.metadata, token, this.documentVersionResourcePath(identifier, document.metadata));
      return document;
    }

    const original = document.data;
    const drained = observePhysicalStream(original);
    const hash = createHash('sha256');
    const chunks: Buffer[] = [];
    try {
      for await (const chunk of original) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        hash.update(buffer);
        chunks.push(buffer);
      }
    } catch (error) {
      if (!original.destroyed) {
        original.destroy();
      }
      await drained.catch(() => undefined);
      throw error;
    }
    await drained;
    const token = await this.buildLocalDocumentVersion(identifier, document.metadata, { digest: hash.digest('hex') });
    writeDocumentVersion(document.metadata, token, this.documentVersionResourcePath(identifier, document.metadata));
    return { data: guardStream(Readable.from(Buffer.concat(chunks))), metadata: document.metadata };
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
    return runPhysicalOperation(this.operationService, async () => {
      const chunks = await arrayifyStream(data as any);
      return chunks
        .map((chunk: Buffer | Uint8Array | string) => typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
        .join('');
    }, data);
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
    await assertCurrentLockOwnership();
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
    this.invalidateMetadataCache(identifier);
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
