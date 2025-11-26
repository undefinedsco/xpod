import type { Readable } from 'stream';
import arrayifyStream from 'arrayify-stream';
import type { Quad, NamedNode } from '@rdfjs/types';
import { DataFactory } from 'n3';
import { 
  isContainerIdentifier,
  RepresentationMetadata,
  INTERNAL_QUADS,
  NotFoundHttpError,
  CONTENT_TYPE_TERM,
  CONTENT_LENGTH_TERM,
  DC,
  POSIX,
  SOLID_META,
  XSD,
  updateModifiedDate,
  toLiteral
} from '@solid/community-server';
import type {
  Representation,
  ResourceIdentifier,
  Guarded,
  DataAccessor,
  IdentifierStrategy,
} from '@solid/community-server';
import { QuadstoreSparqlDataAccessor } from './QuadstoreSparqlDataAccessor';


const { namedNode } = DataFactory;


export class MixDataAccessor extends QuadstoreSparqlDataAccessor {
  private readonly unstructuredDataAccessor: DataAccessor;

  constructor(
    endpoint: string,
    identifierStrategy: IdentifierStrategy,
    unstructuredDataAccessor: DataAccessor,
  ) {
    super(endpoint, identifierStrategy);
    this.unstructuredDataAccessor = unstructuredDataAccessor;
  }

  /**
   * This accessor does support all types of data.
   */
  public override async canHandle(identifier: Representation): Promise<void> {
    return void 0;
  }

  /**
   * Checks if the given representation is unstructured.
   */
  private isUnstructured(identifier: ResourceIdentifier, metadata: RepresentationMetadata): boolean {
    this.logger.info(`${identifier.path} internal content type: ${metadata.contentType}`)
    return metadata.contentType !== INTERNAL_QUADS;
  }

  public override async getData(identifier: ResourceIdentifier): Promise<Guarded<Readable>> {
    const metadata = await this.getMetadata(identifier);
    if (this.isUnstructured(identifier, metadata)) {
      return await this.unstructuredDataAccessor.getData(identifier);
    }
    return await super.getData(identifier);
  }

    /**
   * Returns the metadata for the corresponding identifier.
   */
  public override async getMetadata(identifier: ResourceIdentifier): Promise<RepresentationMetadata> {
      this.logger.info(`Getting metadata for ${identifier.path}`);
      const name = namedNode(identifier.path);
      const query = this.sparqlConstruct(this.getMetadataNode(name));
      const stream = await this.sendSparqlConstruct(query);
      const quads: Quad[] = await arrayifyStream(stream);

      if (quads.length === 0) {
        throw new NotFoundHttpError();
      }

      const metadata = new RepresentationMetadata(identifier).addQuads(quads);
      if (!isContainerIdentifier(identifier) && !metadata.contentType) {
        metadata.contentType = INTERNAL_QUADS;
      }
  
      return metadata;
    }

  public override async writeContainer(
    identifier: ResourceIdentifier,
    metadata: RepresentationMetadata,
  ): Promise<void> {
    if (this.isUnstructured(identifier, metadata)) {
      await this.unstructuredDataAccessor.writeContainer(identifier, metadata);
    }
    await super.writeContainer(identifier, metadata);
  }

  public override async writeDocument(
    identifier: ResourceIdentifier,
    data: Guarded<Readable>,
    metadata: RepresentationMetadata,
  ): Promise<void> {
    if (this.isUnstructured(identifier, metadata)) {
      return await this.writeUnstructuredDocument(identifier, data, metadata);
    } else {
      return await super.writeDocument(identifier, data, metadata);
    }
  }

  public override async deleteResource(identifier: ResourceIdentifier): Promise<void> {
    const metadata = await this.getMetadata(identifier);
    if (this.isUnstructured(identifier, metadata)) {
      await this.unstructuredDataAccessor.deleteResource(identifier);
    }
    return super.deleteResource(identifier);
  }

  private async writeUnstructuredDocument(identifier: ResourceIdentifier, data: Guarded<Readable>, metadata: RepresentationMetadata): Promise<void> {
    await this.unstructuredDataAccessor.writeDocument(identifier, data, metadata);
    metadata = await this.unstructuredDataAccessor.getMetadata(identifier);
    const removing = [];
    for (const quad of metadata.quads()) {
      // ignore invalid quads
      if (!/^http/.test(quad.predicate.value)) {
        removing.push(quad);
      }
    }
    metadata.removeQuads(removing);
    try {
      await super.writeMetadata(identifier, metadata);
    } catch (error) {
      this.logger.error(`Error writing metadata for ${identifier.path}: ${error}`);
      await this.unstructuredDataAccessor.deleteResource(identifier);
      throw error;
    }
  }
}

