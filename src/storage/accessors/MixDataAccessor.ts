import type { Readable } from 'stream';
import { getLoggerFor } from 'global-logger-factory';

import type { Quad } from '@rdfjs/types';
import {
  isContainerIdentifier,
  RepresentationMetadata,
  INTERNAL_QUADS,
  FoundHttpError,
} from '@solid/community-server';
import type {
  Representation,
  ResourceIdentifier,
  Guarded,
  DataAccessor,
} from '@solid/community-server';

/**
 * MixDataAccessor - Routes data to appropriate storage based on content type
 * 
 * - RDF data (internal/quads) -> structuredDataAccessor (Quadstore or QuintStore)
 * - Other data (binary, text, etc.) -> unstructuredDataAccessor (FileSystem, Minio, etc.)
 * 
 * This uses composition instead of inheritance, allowing any DataAccessor
 * to be used as the RDF storage backend.
 */
export class MixDataAccessor implements DataAccessor {
  protected readonly logger = getLoggerFor(this);
  
  private readonly structuredDataAccessor: DataAccessor;
  private readonly unstructuredDataAccessor: DataAccessor;
  private readonly presignedRedirectEnabled: boolean;

  constructor(
    structuredDataAccessor: DataAccessor,
    unstructuredDataAccessor: DataAccessor,
    presignedRedirectEnabled = false,
  ) {
    this.structuredDataAccessor = structuredDataAccessor;
    this.unstructuredDataAccessor = unstructuredDataAccessor;
    this.presignedRedirectEnabled = presignedRedirectEnabled;
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

  public async getMetadata(identifier: ResourceIdentifier): Promise<RepresentationMetadata> {
    // Metadata is always stored in the structured accessor
    const metadata = await this.structuredDataAccessor.getMetadata(identifier);

    // For resources without explicit content type, default to RDF
    // This includes containers (which are always RDF) and documents without contentType
    if (!metadata.contentType) {
      metadata.contentType = INTERNAL_QUADS;
    }

    return metadata;
  }

  public async* getChildren(identifier: ResourceIdentifier): AsyncIterableIterator<RepresentationMetadata> {
    // Children metadata is stored in the structured accessor
    yield* this.structuredDataAccessor.getChildren(identifier);
  }

  public async writeContainer(
    identifier: ResourceIdentifier,
    metadata: RepresentationMetadata,
  ): Promise<void> {
    // Container metadata goes to structured storage
    // Also create in unstructured if it needs to store files
    if (this.isUnstructured(metadata)) {
      await this.unstructuredDataAccessor.writeContainer(identifier, metadata);
    }
    await this.structuredDataAccessor.writeContainer(identifier, metadata);
  }

  public async writeDocument(
    identifier: ResourceIdentifier,
    data: Guarded<Readable>,
    metadata: RepresentationMetadata,
  ): Promise<void> {
    if (this.isUnstructured(metadata)) {
      return await this.writeUnstructuredDocument(identifier, data, metadata);
    }
    return await this.structuredDataAccessor.writeDocument(identifier, data, metadata);
  }

  public async writeMetadata(identifier: ResourceIdentifier, metadata: RepresentationMetadata): Promise<void> {
    // Metadata always goes to structured storage
    return await this.structuredDataAccessor.writeMetadata(identifier, metadata);
  }

  public async deleteResource(identifier: ResourceIdentifier): Promise<void> {
    const metadata = await this.getMetadata(identifier);
    
    // Try to delete from unstructured storage if applicable
    if (this.isUnstructured(metadata)) {
      try {
        await this.unstructuredDataAccessor.deleteResource(identifier);
      } catch (error: any) {
        // Ignore file not found errors
        if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') {
          throw error;
        }
      }
    }
    
    // Always delete from structured storage (contains metadata)
    return await this.structuredDataAccessor.deleteResource(identifier);
  }

  /**
   * Execute SPARQL UPDATE on structured data accessor.
   * Delegates to the underlying structuredDataAccessor if it supports SPARQL.
   */
  public async executeSparqlUpdate(query: string, baseIri?: string): Promise<void> {
    const accessor = this.structuredDataAccessor as { executeSparqlUpdate?: (query: string, baseIri?: string) => Promise<void> };
    if (typeof accessor.executeSparqlUpdate !== 'function') {
      throw new Error('Structured data accessor does not support SPARQL UPDATE');
    }
    return accessor.executeSparqlUpdate(query, baseIri);
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
    
    // Get the metadata from unstructured storage (includes size, etc.)
    let updatedMetadata = await this.unstructuredDataAccessor.getMetadata(identifier);
    
    // Filter out invalid quads
    const removing: Quad[] = [];
    for (const quad of updatedMetadata.quads()) {
      if (!/^http/.test(quad.predicate.value)) {
        removing.push(quad);
      }
    }
    updatedMetadata.removeQuads(removing);
    
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
}
