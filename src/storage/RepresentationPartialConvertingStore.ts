import rdfParser from 'rdf-parse';

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
  getLoggerFor,
  ChangeMap,
  INTERNAL_QUADS,
  APPLICATION_JSON,
} from "@solid/community-server"

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

    // Whitelist: Only allow conversion for known, pure RDF formats.
    // Everything else (HTML, Markdown, Images, random XML/JSON) is treated as a file.
    const SAFE_RDF_TYPES = new Set([
      'text/turtle',
      'application/ld+json',
      'application/n-triples',
      'application/n-quads',
      'application/trig',
      'text/n3',
      'application/rdf+xml',
      INTERNAL_QUADS // Necessary for GET requests to convert internal quads back to public formats
    ]);

    if (!SAFE_RDF_TYPES.has(contentType)) {
      this.logger.debug(`Not converting ${identifier.path}: ${contentType} is not in RDF whitelist`);
      return false;
    }

    try {
      await this.inConverter.canHandle({ identifier, representation, preferences });
      this.logger.info(
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
    this.logger.info(`getRepresentation: ${identifier.path} ${representation.metadata.contentType}`);
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
    this.logger.info(`addResource: ${identifier.path} ${representation.metadata.contentType}`);
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
        this.logger.info(`Converting metadata resource ${identifier.path} to ${INTERNAL_QUADS}`);
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
    this.logger.info(`setRepresentation: ${identifier.path} ${representation.metadata.contentType}`);
    return this.source.setRepresentation(identifier, representation, conditions);
  }
}
