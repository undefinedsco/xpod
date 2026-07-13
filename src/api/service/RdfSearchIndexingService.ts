import { createHash } from 'node:crypto';
import type { EmbeddingService } from '../../ai/service';
import { chunkRdfTextSource } from '../../storage/rdf/RdfTextIndex';
import type {
  RdfEngineLike,
  RdfTextChunkInput,
  RdfTextSourceInput,
  RdfVectorChunkInput,
  RdfVectorSourceInput,
  RdfVectorSummaryMetadata,
} from '../../storage/rdf/types';
import type { StoreContext } from '../chatkit/store';

export type RdfVectorIndexingSkippedReason =
  | 'rdf_engine_unavailable'
  | 'vector_index_unavailable'
  | 'ai_config_unavailable'
  | 'embedding_model_unavailable'
  | 'embedding_provider_failed';

export interface RdfSearchIndexingServiceOptions {
  rdfEngine?: Pick<RdfEngineLike, 'indexVectorSource' | 'deleteVectorSource'>;
  store: {
    getAiConfig(context: StoreContext): Promise<RdfSearchAiConfig | undefined> | RdfSearchAiConfig | undefined;
  };
  embeddingService: Pick<EmbeddingService, 'embedBatch'>;
  maxChunks?: number;
  maxEmbeddingInputChars?: number;
  embeddingInputKinds?: RdfEmbeddingInputKind[];
  projectionPolicyVersion?: string;
  summaryService?: RdfEmbeddingSummaryService;
  summaryPromptVersion?: string;
}

export interface RdfSearchAiConfig {
  providerId: string;
  baseUrl: string;
  proxyUrl?: string;
  defaultModel?: string;
  embeddingModel?: string;
  embeddingModelVersion?: string;
  apiKey: string;
  credentialId: string;
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
    skippedInputs?: RdfSkippedEmbeddingInput[];
    summarizedInputs?: RdfSummarizedEmbeddingInput[];
  }
  | {
    status: 'skipped';
    source: string;
    reason: RdfVectorIndexingSkippedReason;
    message?: string;
  };

export interface RdfVectorDeleteResult {
  status: 'deleted' | 'skipped';
  source: string;
  deletedChunks: number;
  reason?: 'rdf_engine_unavailable' | 'vector_index_unavailable';
}

export type RdfEmbeddingInputKind = 'locator' | 'semantic';

interface RdfEmbeddingInput {
  kind: RdfEmbeddingInputKind;
  chunk: RdfTextChunkInput;
  content: string;
  inputHash: string;
  summaryMetadata?: RdfVectorSummaryMetadata;
}

export interface RdfSkippedEmbeddingInput {
  chunkKey: string;
  inputKind: RdfEmbeddingInputKind;
  reason: 'input_too_large' | 'summary_failed' | 'summary_too_large';
  inputChars: number;
  maxChars: number;
  summaryChars?: number;
  message?: string;
}

export interface RdfEmbeddingSummaryRequest {
  content: string;
  inputKind: RdfEmbeddingInputKind;
  chunkKey: string;
  sourceHash?: string;
  maxChars: number;
  promptVersion: string;
}

export interface RdfEmbeddingSummaryResult {
  content: string;
  provider: string;
  model: string;
  promptVersion?: string;
  rounds?: number;
}

export interface RdfEmbeddingSummaryService {
  summarize(request: RdfEmbeddingSummaryRequest): Promise<RdfEmbeddingSummaryResult> | RdfEmbeddingSummaryResult;
}

export interface RdfSummarizedEmbeddingInput {
  chunkKey: string;
  inputKind: RdfEmbeddingInputKind;
  originalChars: number;
  summaryChars: number;
  rounds: number;
}

const DEFAULT_EMBEDDING_INPUT_KINDS: RdfEmbeddingInputKind[] = ['semantic'];
const DEFAULT_PROJECTION_POLICY_VERSION = 'rdf-vector-projection-v1';
const DEFAULT_SUMMARY_PROMPT_VERSION = 'rdf-embedding-summary-v1';

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
    const { accepted: embeddingInputs, skipped: skippedInputs, summarized: summarizedInputs } = await this.resolveEmbeddingInputBudget(
      source,
      this.embeddingInputs(source, textChunks),
    );
    if (embeddingInputs.length === 0) {
      await this.options.rdfEngine.indexVectorSource(source, []);
      return this.indexedResult(source.source, undefined, 0, skippedInputs, summarizedInputs);
    }

    const config = await this.options.store.getAiConfig(input.context);
    if (!config?.apiKey) {
      return { status: 'skipped', source: source.source, reason: 'ai_config_unavailable' };
    }
    if (!config.embeddingModel) {
      return { status: 'skipped', source: source.source, reason: 'embedding_model_unavailable' };
    }

    const contents = embeddingInputs.map((embeddingInput) => embeddingInput.content);
    let embeddings: number[][];
    try {
      embeddings = await this.options.embeddingService.embedBatch(contents, {
        provider: config.providerId,
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        proxyUrl: config.proxyUrl,
      }, config.embeddingModel);
    } catch (error) {
      return {
        status: 'skipped',
        source: source.source,
        reason: 'embedding_provider_failed',
        message: error instanceof Error ? error.message : String(error),
      };
    }

    if (embeddings.length !== embeddingInputs.length) {
      throw new Error(`Embedding batch returned ${embeddings.length} vectors for ${embeddingInputs.length} RDF embedding inputs`);
    }

    const projectionPolicyVersion = this.projectionPolicyVersion();
    await this.options.rdfEngine.indexVectorSource(
      source,
      embeddingInputs.map(({ chunk, kind, content, inputHash, summaryMetadata }, index): RdfVectorChunkInput => ({
        chunkKey: chunk.chunkKey,
        ordinal: chunk.ordinal,
        level: chunk.level,
        embedding: embeddings[index],
        provider: config.providerId,
        model: config.embeddingModel,
        modelVersion: config.embeddingModelVersion,
        inputKind: kind,
        inputHash,
        projectionPolicyVersion,
        heading: chunk.heading,
        path: chunk.path,
        content,
        startOffset: chunk.startOffset,
        endOffset: chunk.endOffset,
        summaryMetadata,
      })),
    );

    return this.indexedResult(source.source, config.embeddingModel, embeddingInputs.length, skippedInputs, summarizedInputs);
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

  private embeddingInputs(
    source: RdfTextSourceInput,
    chunks: RdfTextChunkInput[],
  ): RdfEmbeddingInput[] {
    const kinds = this.embeddingInputKinds();
    const inputs: RdfEmbeddingInput[] = [];
    for (const chunk of chunks) {
      for (const kind of kinds) {
        const content = this.embeddingInputContent(source, chunk, kind);
        if (!content) {
          continue;
        }
        inputs.push({
          kind,
          chunk,
          content,
          inputHash: createHash('sha256').update(content).digest('hex'),
        });
      }
    }
    return inputs;
  }

  private embeddingInputKinds(): RdfEmbeddingInputKind[] {
    const configured = this.options.embeddingInputKinds?.length
      ? this.options.embeddingInputKinds
      : DEFAULT_EMBEDDING_INPUT_KINDS;
    return [...new Set(configured)];
  }

  private projectionPolicyVersion(): string {
    return this.options.projectionPolicyVersion ?? DEFAULT_PROJECTION_POLICY_VERSION;
  }

  private embeddingInputContent(
    source: RdfTextSourceInput,
    chunk: RdfTextChunkInput,
    kind: RdfEmbeddingInputKind,
  ): string {
    if (kind === 'semantic') {
      return chunk.content.trim();
    }

    const sections: string[] = [];
    const path = source.localPath?.split(/[\\/]+/).filter(Boolean).join(' / ');
    if (path) {
      sections.push(`Path: ${path}`);
    }
    const headingPath = chunk.path?.length ? chunk.path : (chunk.heading ? [chunk.heading] : []);
    if (headingPath.length > 0) {
      sections.push(`Heading: ${headingPath.join(' / ')}`);
    }
    return sections.join('\n').trim();
  }

  private async resolveEmbeddingInputBudget(
    source: RdfTextSourceInput,
    inputs: RdfEmbeddingInput[],
  ): Promise<{
    accepted: RdfEmbeddingInput[];
    skipped: RdfSkippedEmbeddingInput[];
    summarized: RdfSummarizedEmbeddingInput[];
  }> {
    const maxChars = this.options.maxEmbeddingInputChars;
    if (!maxChars || maxChars <= 0) {
      return { accepted: inputs, skipped: [], summarized: [] };
    }

    const accepted: RdfEmbeddingInput[] = [];
    const skipped: RdfSkippedEmbeddingInput[] = [];
    const summarized: RdfSummarizedEmbeddingInput[] = [];
    for (const input of inputs) {
      if (input.content.length > maxChars) {
        const summary = await this.summarizeEmbeddingInput(source, input, maxChars);
        if ('input' in summary) {
          accepted.push(summary.input);
          summarized.push(summary.summary);
        } else {
          skipped.push(summary.skipped);
        }
      } else {
        accepted.push(input);
      }
    }
    return { accepted, skipped, summarized };
  }

  private async summarizeEmbeddingInput(
    source: RdfTextSourceInput,
    input: RdfEmbeddingInput,
    maxChars: number,
  ): Promise<
    | { input: RdfEmbeddingInput; summary: RdfSummarizedEmbeddingInput }
    | { skipped: RdfSkippedEmbeddingInput }
  > {
    const service = this.options.summaryService;
    if (!service) {
      return { skipped: this.skippedEmbeddingInput(input, maxChars, 'input_too_large') };
    }

    const promptVersion = this.options.summaryPromptVersion ?? DEFAULT_SUMMARY_PROMPT_VERSION;
    let result: RdfEmbeddingSummaryResult;
    try {
      result = await service.summarize({
        content: input.content,
        inputKind: input.kind,
        chunkKey: input.chunk.chunkKey,
        sourceHash: source.sourceHash,
        maxChars,
        promptVersion,
      });
    } catch (error) {
      return {
        skipped: this.skippedEmbeddingInput(
          input,
          maxChars,
          'summary_failed',
          error instanceof Error ? error.message : String(error),
        ),
      };
    }
    const content = result.content.trim();
    if (!content || content.length > maxChars) {
      return {
        skipped: this.skippedEmbeddingInput(
          input,
          maxChars,
          'summary_too_large',
          undefined,
          content.length,
        ),
      };
    }
    const rounds = result.rounds ?? 1;
    const summaryMetadata: RdfVectorSummaryMetadata = {
      status: 'summarized',
      provider: result.provider,
      model: result.model,
      promptVersion: result.promptVersion ?? promptVersion,
      ...(source.sourceHash ? { sourceHash: source.sourceHash } : {}),
      originalChars: input.content.length,
      summaryChars: content.length,
      rounds,
    };
    return {
      input: {
        ...input,
        content,
        inputHash: createHash('sha256').update(content).digest('hex'),
        summaryMetadata,
      },
      summary: {
        chunkKey: input.chunk.chunkKey,
        inputKind: input.kind,
        originalChars: input.content.length,
        summaryChars: content.length,
        rounds,
      },
    };
  }

  private skippedEmbeddingInput(
    input: RdfEmbeddingInput,
    maxChars: number,
    reason: RdfSkippedEmbeddingInput['reason'],
    message?: string,
    summaryChars?: number,
  ): RdfSkippedEmbeddingInput {
    return {
      chunkKey: input.chunk.chunkKey,
      inputKind: input.kind,
      reason,
      inputChars: input.content.length,
      maxChars,
      ...(summaryChars !== undefined ? { summaryChars } : {}),
      ...(message ? { message } : {}),
    };
  }

  private indexedResult(
    source: string,
    model: string | undefined,
    chunkCount: number,
    skippedInputs: RdfSkippedEmbeddingInput[],
    summarizedInputs: RdfSummarizedEmbeddingInput[] = [],
  ): RdfVectorIndexingResult {
    return {
      status: 'indexed',
      source,
      ...(model ? { model } : {}),
      chunkCount,
      ...(skippedInputs.length > 0 ? { skippedInputs } : {}),
      ...(summarizedInputs.length > 0 ? { summarizedInputs } : {}),
    };
  }
}
