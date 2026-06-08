import { createHash } from 'node:crypto';
import type { EmbeddingService } from '../../ai/service';
import { chunkRdfTextSource } from '../../storage/rdf/RdfTextIndex';
import type {
  RdfEngineLike,
  RdfTextChunkInput,
  RdfTextSourceInput,
  RdfVectorChunkInput,
  RdfVectorSourceInput,
} from '../../storage/rdf/types';
import type { PodChatKitStore } from '../chatkit/pod-store';
import type { StoreContext } from '../chatkit/store';

export type RdfVectorIndexingSkippedReason =
  | 'rdf_engine_unavailable'
  | 'vector_index_unavailable'
  | 'ai_config_unavailable'
  | 'embedding_model_unavailable';

export interface RdfSearchIndexingServiceOptions {
  rdfEngine?: Pick<RdfEngineLike, 'indexVectorSource' | 'deleteVectorSource'>;
  store: Pick<PodChatKitStore, 'getAiConfig'>;
  embeddingService: Pick<EmbeddingService, 'embedBatch'>;
  maxChunks?: number;
}

export interface IndexRdfVectorSourceInput {
  context: StoreContext;
  source: RdfTextSourceInput & RdfVectorSourceInput;
  text?: string;
  chunks?: RdfTextChunkInput[];
}

export interface DeleteRdfVectorSourceInput {
  source: string;
}

export type RdfVectorIndexingResult =
  | {
    status: 'indexed';
    source: string;
    model?: string;
    chunkCount: number;
  }
  | {
    status: 'skipped';
    source: string;
    reason: RdfVectorIndexingSkippedReason;
  };

export interface RdfVectorDeleteResult {
  status: 'deleted' | 'skipped';
  source: string;
  deletedChunks: number;
  reason?: 'rdf_engine_unavailable' | 'vector_index_unavailable';
}

/**
 * Product-level bridge from Pod-owned AI credentials to the RDF vector index.
 *
 * CSS storage writes can keep text search sources current because they already
 * have the resource bytes. Vector writes need user Pod AI credentials, so they
 * live here at the product/service boundary instead of inside MixDataAccessor.
 */
export class RdfSearchIndexingService {
  public constructor(private readonly options: RdfSearchIndexingServiceOptions) {}

  public async indexVectorSource(input: IndexRdfVectorSourceInput): Promise<RdfVectorIndexingResult> {
    if (!this.options.rdfEngine) {
      return { status: 'skipped', source: input.source.source, reason: 'rdf_engine_unavailable' };
    }
    if (!this.options.rdfEngine.indexVectorSource) {
      return { status: 'skipped', source: input.source.source, reason: 'vector_index_unavailable' };
    }

    const source = this.sourceWithHash(input.source, input.text);
    const textChunks = this.textChunks(source, input);
    if (textChunks.length === 0) {
      await this.options.rdfEngine.indexVectorSource(source, []);
      return { status: 'indexed', source: source.source, chunkCount: 0 };
    }

    const config = await this.options.store.getAiConfig(input.context);
    if (!config?.apiKey) {
      return { status: 'skipped', source: source.source, reason: 'ai_config_unavailable' };
    }
    if (!config.embeddingModel) {
      return { status: 'skipped', source: source.source, reason: 'embedding_model_unavailable' };
    }

    const contents = textChunks.map((chunk) => chunk.content);
    const embeddings = await this.options.embeddingService.embedBatch(contents, {
      provider: config.providerId,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      proxyUrl: config.proxyUrl,
    }, config.embeddingModel);

    if (embeddings.length !== textChunks.length) {
      throw new Error(`Embedding batch returned ${embeddings.length} vectors for ${textChunks.length} RDF chunks`);
    }

    await this.options.rdfEngine.indexVectorSource(
      source,
      textChunks.map((chunk, index): RdfVectorChunkInput => ({
        chunkKey: chunk.chunkKey,
        ordinal: chunk.ordinal,
        level: chunk.level,
        embedding: embeddings[index],
        model: config.embeddingModel,
        heading: chunk.heading,
        path: chunk.path,
        content: chunk.content,
        startOffset: chunk.startOffset,
        endOffset: chunk.endOffset,
      })),
    );

    return {
      status: 'indexed',
      source: source.source,
      model: config.embeddingModel,
      chunkCount: textChunks.length,
    };
  }

  public async deleteVectorSource(input: DeleteRdfVectorSourceInput): Promise<RdfVectorDeleteResult> {
    if (!this.options.rdfEngine) {
      return {
        status: 'skipped',
        source: input.source,
        deletedChunks: 0,
        reason: 'rdf_engine_unavailable',
      };
    }
    if (!this.options.rdfEngine.deleteVectorSource) {
      return {
        status: 'skipped',
        source: input.source,
        deletedChunks: 0,
        reason: 'vector_index_unavailable',
      };
    }

    const deletedChunks = await this.options.rdfEngine.deleteVectorSource(input.source);
    return {
      status: 'deleted',
      source: input.source,
      deletedChunks,
    };
  }

  private sourceWithHash(
    source: RdfTextSourceInput & RdfVectorSourceInput,
    text: string | undefined,
  ): RdfTextSourceInput & RdfVectorSourceInput {
    if (source.sourceHash || text === undefined) {
      return source;
    }
    return {
      ...source,
      sourceHash: createHash('sha256').update(text).digest('hex'),
    };
  }

  private textChunks(
    source: RdfTextSourceInput,
    input: IndexRdfVectorSourceInput,
  ): RdfTextChunkInput[] {
    const chunks = input.chunks ?? (input.text !== undefined ? chunkRdfTextSource(source, input.text) : []);
    const maxChunks = this.options.maxChunks;
    const filtered = chunks.filter((chunk) => chunk.content.trim().length > 0);
    return maxChunks && maxChunks > 0 ? filtered.slice(0, maxChunks) : filtered;
  }
}
