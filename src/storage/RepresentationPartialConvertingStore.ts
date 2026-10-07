import rdfParser from 'rdf-parse';
import { getLoggerFor } from 'global-logger-factory';
import { Readable } from 'node:stream';

import {
  BasicRepresentation,
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
import {
  clearDocumentVersion,
  parseDocumentVersion,
  readDocumentVersion,
  sanitizeRepresentationId,
  sha256Hex,
  writeDocumentVersion,
  writeDocumentVersionSuppressed,
} from './rdf/DocumentVersion'

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

  /**
   * Memory bound for materializing a converted representation before headers. Within the bound the
   * exact selected bytes are captured so the validator can be decided synchronously; above it the
   * surface is marked validator-less rather than reusing an unrelated strong validator.
   */
  private static readonly CONVERTED_VERSION_MAX_BYTES = 16 * 1024 * 1024;

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
    const before = await super.getRepresentation(identifier, preferences, conditions);
    if (!(await this.shouldConvert(identifier, before, preferences))) {
      return before;
    }
    const rawToken = readDocumentVersion(before.metadata);
    const resourcePath = before.metadata.identifier?.value;
    let representation = await this.outConverter.handleSafe({ identifier, representation: before, preferences });
    if (!rawToken || !resourcePath) {
      // Unverified/unqualified surfaces keep the raw marker out of the delivered metadata.
      clearDocumentVersion(representation.metadata);
      return representation;
    }
    // A converted surface must never reuse the raw Turtle strong validator. Only a byte stream can
    // be captured to prove byte identity; an RDF quad (object) stream or any other non-byte stream
    // has no exact-byte Turtle validator, so omit the validator explicitly instead of falling back
    // to a collision-prone seconds validator.
    if (representation.binary !== true) {
      writeDocumentVersionSuppressed(representation.metadata, resourcePath);
      return representation;
    }
    // The delivered bytes are produced by the converter now. Capture them within the bound so the
    // strongest honest validator can be attached: the exact raw authority token when the converter
    // round-tripped to identical bytes, otherwise a sealed directive that omits the validator.
    const captured = await this.captureConvertedStream(representation.data as unknown as Readable);
    if (captured.kind === 'passthrough') {
      representation = new BasicRepresentation(captured.replay, representation.metadata, true);
      writeDocumentVersionSuppressed(representation.metadata, resourcePath);
      return representation;
    }
    if (captured.kind === 'exceeded') {
      representation = new BasicRepresentation(
        Readable.from((async function* replay(): AsyncGenerator<Buffer> {
          yield captured.prefix;
          for await (const chunk of captured.stream as AsyncIterable<Buffer>) {
            yield chunk;
          }
        })()),
        representation.metadata,
        true,
      );
      writeDocumentVersionSuppressed(representation.metadata, resourcePath);
      return representation;
    }
    const parts = parseDocumentVersion(rawToken);
    const contentType = representation.metadata.contentType;
    const digest = sha256Hex(captured.buffer);
    const representationId = contentType ? sanitizeRepresentationId(contentType) : undefined;
    const identical = Boolean(parts && representationId &&
      parts.byteDigest === digest && parts.representationId === representationId);
    representation = new BasicRepresentation(Readable.from([ captured.buffer ]), representation.metadata, true);
    if (identical) {
      writeDocumentVersion(representation.metadata, rawToken, resourcePath);
    } else {
      writeDocumentVersionSuppressed(representation.metadata, resourcePath);
    }
    return representation;
  }

  /**
   * Read a converted stream up to the bounded cap. Byte streams are captured whole; on overflow the
   * stream is paused with its remaining bytes intact so the caller can hand it off without data loss.
   * A non-byte chunk (for example an RDF quad stream) stops capture immediately and hands back the
   * untouched sequence, so an object stream is never forced through `Buffer.from`.
   */
  private captureConvertedStream(stream: Readable): Promise<
  | { kind: 'bytes'; buffer: Buffer }
  | { kind: 'exceeded'; prefix: Buffer; stream: Readable }
  | { kind: 'passthrough'; replay: Readable }> {
    const max = RepresentationPartialConvertingStore.CONVERTED_VERSION_MAX_BYTES;
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let total = 0;
      let settled = false;
      const isByteChunk = (chunk: unknown): chunk is Buffer | string =>
        Buffer.isBuffer(chunk) || typeof chunk === 'string' || chunk instanceof Uint8Array;
      const replayFrom = (first: unknown): Readable => Readable.from(
        (async function* replay(): AsyncGenerator<unknown> {
          for (const chunk of chunks) {
            yield chunk;
          }
          yield first;
          for await (const chunk of stream as AsyncIterable<unknown>) {
            yield chunk;
          }
        })(),
      );
      const onData = (chunk: unknown): void => {
        if (settled) {
          return;
        }
        if (!isByteChunk(chunk)) {
          settled = true;
          stream.off('data', onData);
          stream.pause();
          resolve({ kind: 'passthrough', replay: replayFrom(chunk) });
          return;
        }
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buffer.length;
        chunks.push(buffer);
        if (total > max) {
          settled = true;
          stream.off('data', onData);
          stream.pause();
          resolve({ kind: 'exceeded', prefix: Buffer.concat(chunks), stream });
        }
      };
      stream.on('data', onData);
      stream.once('end', () => {
        if (settled) {
          return;
        }
        settled = true;
        stream.off('data', onData);
        resolve({ kind: 'bytes', buffer: Buffer.concat(chunks) });
      });
      stream.once('error', (error) => {
        if (settled) {
          return;
        }
        settled = true;
        stream.off('data', onData);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
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
