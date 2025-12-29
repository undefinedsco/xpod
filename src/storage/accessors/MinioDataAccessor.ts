import { Client, BucketItemStat } from 'minio';
import { getLoggerFor } from 'global-logger-factory';
import type { DataAccessor } from '@solid/community-server';
import type { Readable } from 'node:stream';
import { DataFactory } from 'n3';
import {
  RepresentationMetadata,
  
  NotFoundHttpError,
  guardStream,
  isContainerIdentifier,
  isContainerPath,
  joinFilePath,
  UnsupportedMediaTypeHttpError,
  CONTENT_TYPE_TERM,
  DC,
  IANA,
  LDP,
  POSIX,
  RDF,
  SOLID_META,
  XSD,
  parseQuads,
  serializeQuads,
  addResourceMetadata,
  updateModifiedDate,
  toLiteral,
  toNamedTerm,
} from '@solid/community-server';
import type { Guarded } from '@solid/community-server';
import type { FileIdentifierMapper, ResourceLink } from '@solid/community-server';
import type { 
  ResourceIdentifier,
  Representation,
  MetadataRecord
} from '@solid/community-server';

export class MinioDataAccessor implements DataAccessor {
  protected readonly logger = getLoggerFor(this);
  protected readonly resourceMapper: FileIdentifierMapper;
  private readonly client: Client;
  private readonly bucketName: string;

  public constructor(
    resourceMapper: FileIdentifierMapper,
    accessKey: string,
    secretKey: string,
    endpoint: string,
    bucketName: string,
  ) {
    this.resourceMapper = resourceMapper;
    this.client = new Client({
      accessKey,
      secretKey,
      endPoint: endpoint,
      useSSL: true,
    });
    this.bucketName = bucketName;
    this.logger.info(`MinioDataAccessor initialized with endpoint: ${endpoint}`)
  }

  /**
   * Should throw a NotImplementedHttpError if the DataAccessor does not support storing the given Representation.
   *
   * @param representation - Incoming Representation.
   *
   * @throws BadRequestHttpError
   * If it does not support the incoming data.
   */
  public async canHandle(representation: Representation): Promise<void> {
    if (!representation.binary) {
      throw new UnsupportedMediaTypeHttpError('Only binary data is supported.');
    }
  }

  /**
   * Returns a data stream stored for the given identifier.
   * It can be assumed that the incoming identifier will always correspond to a document.
   *
   * @param identifier - Identifier for which the data is requested.
   */
  public async getData(identifier: ResourceIdentifier): Promise<Guarded<Readable>> {
    const url = new URL(identifier.path)
    const stream = await this.client.getObject(this.bucketName, url.pathname);
    return guardStream(stream);
  }

  /**
   * Returns the metadata corresponding to the identifier.
   * If possible, it is suggested to add a `posix:size` triple to the metadata indicating the binary size.
   * This is necessary for range requests.
   *
   * @param identifier - Identifier for which the metadata is requested.
   */
  public async getMetadata(identifier: ResourceIdentifier): Promise<RepresentationMetadata> {
    const url = new URL(identifier.path)
    const link = await this.resourceMapper.mapUrlToFilePath(identifier, false);
    const isDirectory = identifier.path.endsWith('/');
    const objectName = isDirectory ? `${url.pathname}/.container` : url.pathname;
    let stats: BucketItemStat;
    try {
      stats = await this.client.statObject(this.bucketName, objectName);
    } catch (error) {
      throw new NotFoundHttpError();
    }
    if (!isContainerIdentifier(identifier) && !isDirectory) {
      return this.getFileMetadata(link, stats);
    }
    if (isContainerIdentifier(identifier) && isDirectory) {
      return this.getDirectoryMetadata(link, stats);
    }
    throw new NotFoundHttpError();
  }

  /**
   * Returns metadata for all resources in the requested container.
   * This should not be all metadata of those resources (but it can be),
   * but instead the main metadata you want to show in situations
   * where all these resources are presented simultaneously.
   * Generally this would be metadata that is present for all of these resources,
   * such as resource type or last modified date.
   *
   * It can be safely assumed that the incoming identifier will always correspond to a container.
   *
   * @param identifier - Identifier of the parent container.
   */
  public async* getChildren(identifier: ResourceIdentifier): AsyncIterableIterator<RepresentationMetadata> {
    const url = new URL(identifier.path)
    const objects = this.client.listObjectsV2(this.bucketName, url.pathname);
    for await (const object of objects) {
      const metadata = await this.getMetadata(object);
      yield metadata;
    }
  }

  /**
   * Writes data and metadata for a document.
   * If any data and/or metadata exist for the given identifier, it should be overwritten.
   *
   * @param identifier - Identifier of the resource.
   * @param data - Data to store.
   * @param metadata - Metadata to store.
   */
  public async writeDocument(identifier: ResourceIdentifier, data: Guarded<Readable>, metadata: RepresentationMetadata): Promise<void> {
    const url = new URL(identifier.path);
    const link = await this.resourceMapper.mapUrlToFilePath(identifier, false);
    const itemMetadata = this.encodeMetadata(link, metadata);
    try {
      await this.client.putObject(
        this.bucketName,
        url.pathname,
        data,
        metadata.contentLength,
        itemMetadata || undefined,
      );
    } catch (error) {
      this.logger.error(`Error writing document: ${identifier.path} ${error}`)
      throw error;
    }
  }

  /**
   * Writes metadata for a container.
   * If the container does not exist yet it should be created,
   * if it does its metadata should be overwritten, except for the containment triples.
   *
   * @param identifier - Identifier of the container.
   * @param metadata - Metadata to store.
   */
  public async writeContainer(identifier: ResourceIdentifier, metadata: RepresentationMetadata): Promise<void> {
    const url = new URL(identifier.path)
    const link = await this.resourceMapper.mapUrlToFilePath(identifier, false);
    await this.client.putObject(
      this.bucketName,
      `${url.pathname}/.container`,
      Buffer.from(''),
      metadata.contentLength,
      this.encodeMetadata(link, metadata) || undefined,
    );
  }

  /**
   * Writes metadata for a resource.
   * It can safely be assumed that the subject resource already exists.
   *
   * @param identifier - Identifier of the subject resource.
   * @param metadata - Metadata to store.
   */
  public async writeMetadata(identifier: ResourceIdentifier, metadata: RepresentationMetadata): Promise<void> {
    throw new Error('Minio does not support writing metadata for a resource.');
  }

  /**
   * Deletes the resource and its corresponding metadata.
   *
   * Solid, §5.4: "When a contained resource is deleted, the server MUST also remove the corresponding containment
   * triple, which has the effect of removing the deleted resource from the containing container."
   * https://solid.github.io/specification/protocol#deleting-resources
   *
   * @param identifier - Resource to delete.
   */
  public async deleteResource(identifier: ResourceIdentifier): Promise<void> {
    const link = new URL(identifier.path)
    await this.client.removeObject(this.bucketName, link.pathname);
  }

  /**
   * Reads and generates all metadata relevant for the given file,
   * ingesting it into a RepresentationMetadata object.
   *
   * @param link - Path related metadata.
   * @param stats - Stats object of the corresponding file.
   */
  private async getFileMetadata(link: ResourceLink, stats: BucketItemStat): Promise<RepresentationMetadata> {
    const metadata = await this.getBaseMetadata(link, stats, false);
      // If the resource is using an unsupported contentType, the original contentType was written to the metadata file.
      // As a result, we should only set the contentType derived from the file path,
      // when no previous metadata entry for contentType is present.
    if (typeof metadata.contentType === 'undefined') {
      metadata.set(CONTENT_TYPE_TERM, link.contentType);
    }
    return metadata;
  }

  /**
   * Reads and generates all metadata relevant for the given directory,
   * ingesting it into a RepresentationMetadata object.
   *
   * @param link - Path related metadata.
   * @param stats - Stats object of the corresponding directory.
   */
  private async getDirectoryMetadata(link: ResourceLink, stats: BucketItemStat): Promise<RepresentationMetadata> {
    return this.getBaseMetadata(link, stats, true);
  }
  
  /**
   * Generates metadata relevant for any resources stored by this accessor.
   *
   * @param link - Path related metadata.
   * @param stats - Stats objects of the corresponding directory.
   * @param isContainer - If the path points to a container (directory) or not.
   */
  private async getBaseMetadata(link: ResourceLink, stats: BucketItemStat, isContainer: boolean): Promise<RepresentationMetadata> {
    const metadata = this.decodeMetadata(link, stats.metaData);
    addResourceMetadata(metadata, isContainer);
    this.addPosixMetadata(metadata, stats, isContainer);
    return metadata;
  }
  
  /**
   * Helper function to add file system related metadata.
   *
   * @param metadata - metadata object to add to
   * @param stats - Stats of the file/directory corresponding to the resource.
   */
  private addPosixMetadata(metadata: RepresentationMetadata, stats: BucketItemStat, isDirectory: boolean): void {
    updateModifiedDate(metadata, stats.lastModified);
    metadata.add(
      POSIX.terms.mtime,
      toLiteral(Math.floor(stats.lastModified.getTime() / 1000), XSD.terms.integer),
      SOLID_META.terms.ResponseMetadata,
    );
    if (!isDirectory) {
      metadata.add(
        POSIX.terms.size,
        toLiteral(stats.size, XSD.terms.integer),
        SOLID_META.terms.ResponseMetadata,
      );
    }
  }

  /**
   * encode the metadata of the resource to string.
   *
   * @param link - Path related metadata of the resource.
   * @param metadata - Metadata to write.
   *
   * @returns string of metadata.
   */
  protected encodeMetadata(link: ResourceLink, metadata: RepresentationMetadata): object | null {
    // These are stored by file system conventions
    metadata.remove(RDF.terms.type, LDP.terms.Resource);
    metadata.remove(RDF.terms.type, LDP.terms.Container);
    metadata.remove(RDF.terms.type, LDP.terms.BasicContainer);
    metadata.removeAll(DC.terms.modified);
    // When writing metadata for a document, only remove the content-type when dealing with a supported media type.
    // A media type is supported if the FileIdentifierMapper can correctly store it.
    // This allows restoring the appropriate content-type on data read (see getFileMetadata).
    if (isContainerPath(link.filePath) || typeof metadata.contentType !== 'undefined') {
      metadata.removeAll(CONTENT_TYPE_TERM);
    }
    const contentTypeObject = metadata.contentTypeObject
    if (contentTypeObject === undefined
      || Object.keys(contentTypeObject.parameters).length === 0) {
      return null;
    }
    // Write metadata to file if there are quads remaining
    return contentTypeObject.parameters;
  }

  protected decodeMetadata(link: ResourceLink, metadata: MetadataRecord): RepresentationMetadata {
    return new RepresentationMetadata(link.identifier, metadata);
  }
}
