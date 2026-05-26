import rdfParser from 'rdf-parse';
import { getLoggerFor } from 'global-logger-factory';

import {
  PassthroughStore,
  PassthroughConverter,
  AuxiliaryStrategy,
  ResourceStore,
  RepresentationConverter,
  RepresentationPreferences,
  ResourceIdentifier,
  Representation,
  RepresentationConverterArgs,
  Conditions,
  
  ChangeMap,
  INTERNAL_QUADS,
  APPLICATION_JSON,
} from "@solid/community-server"
import { isSafeRdfDocumentContentType } from './rdf/RdfContentTypes'

interface RepresentationPartialConvertingStoreOptions {
  outConverter?: RepresentationConverter
  inConverter?: RepresentationConverter
  inPreferences?: RepresentationPreferences
}

/**
 * A store that converts representations based on their content type.
 */
export class RepresentationPartialConvertingStore<T extends ResourceStore = ResourceStore> extends PassthroughStore<T> {
  protected readonly logger = getLoggerFor(this)

  private readonly metadataStrategy: AuxiliaryStrategy
  private readonly inConverter: RepresentationConverter
  private readonly outConverter: RepresentationConverter
  private readonly inPreferences: RepresentationPreferences
  
  constructor(
    source: T,
    metadataStrategy: AuxiliaryStrategy,
    options: RepresentationPartialConvertingStoreOptions,
  ) {
    super(source)
    this.metadataStrategy = metadataStrategy
    this.inConverter = options.inConverter ?? new PassthroughConverter();
    this.outConverter = options.outConverter ?? new PassthroughConverter();
    this.inPreferences = options.inPreferences ?? {};

    const inConverterClass = this.inConverter.constructor.name;
    const outConverterClass = this.outConverter.constructor.name;
    this.logger.debug(
      `Initializing with inConverter: ${inConverterClass}, 
      outConverter: ${outConverterClass}, 
      inPreferences: ${JSON.stringify(this.inPreferences)}`);
  }

  private async shouldConvert(
    identifier: ResourceIdentifier,
    representation: Representation,
    preferences: RepresentationPreferences,
  ) {
    if (representation.metadata.contentType === undefined) {
      return false
    }

    const contentType = representation.metadata.contentType;
    const preferencesType = Object.keys(preferences.type || {})[0];

    if (preferences.type?.[contentType]) {
      this.logger.debug(`Not converting ${identifier.path}: ${contentType} already satisfies preferences`);
      return false;
    }

    if (contentType !== INTERNAL_QUADS && !isSafeRdfDocumentContentType(contentType)) {
      this.logger.debug(`Not converting ${identifier.path}: ${contentType} is not in RDF whitelist`);
      return false;
    }

    try {
      await this.inConverter.canHandle({ identifier, representation, preferences });
      this.logger.debug(
        `Converting ${identifier.path}: ${contentType} to ${preferencesType}`,
      );
      return true;
    } catch (error) {
      this.logger.debug(`Not converting ${identifier.path}: ${contentType} to ${preferencesType}. Error: ${error}`);
      return false;
    }
  }

  public override async getRepresentation(
    identifier: ResourceIdentifier,
    preferences: RepresentationPreferences,
    conditions?: Conditions,
  ): Promise<Representation> {
    let representation = await super.getRepresentation(identifier, preferences, conditions);
    if (await this.shouldConvert(identifier, representation, preferences)) {
      representation = await this.outConverter.handleSafe({ identifier, representation, preferences });
    }
    return representation;
  }

  public override async addResource(
    identifier: ResourceIdentifier,
    representation: Representation,
    conditions?: Conditions,
  ): Promise<ChangeMap> {
    // In case of containers, no content-type is required and the representation is not used.
    try {
      if (await this.shouldConvert(identifier, representation, this.inPreferences)) {
        // We can potentially run into problems here if we convert a turtle document where the base IRI is required,
        // since we don't know the resource IRI yet at this point.
        representation = await this.inConverter.handleSafe(
          { identifier, representation, preferences: this.inPreferences },
        );
      }
    } catch (error) {
      this.logger.warn(`Conversion skipped for ${identifier.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return this.source.addResource(identifier, representation, conditions);
  }

  public override async setRepresentation(
    identifier: ResourceIdentifier,
    representation: Representation,
    conditions?: Conditions,
  ): Promise<ChangeMap> {
    try {
      // When it is a metadata resource, convert it to Quads as those are expected in the later stores
      if (this.metadataStrategy.isAuxiliaryIdentifier(identifier)) {
        this.logger.debug(`Converting metadata resource ${identifier.path} to ${INTERNAL_QUADS}`);
        representation = await this.inConverter.handleSafe(
          { identifier, representation, preferences: { type: { [INTERNAL_QUADS]: 1 }}},
        );
      } else if (await this.shouldConvert(identifier, representation, this.inPreferences)) {
        representation = await this.inConverter.handleSafe(
          { identifier, representation, preferences: this.inPreferences },
        );
      }
    } catch (error) {
      this.logger.warn(`Conversion skipped for ${identifier.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return this.source.setRepresentation(identifier, representation, conditions);
  }
}
