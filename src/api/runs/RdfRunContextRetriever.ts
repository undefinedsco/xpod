import { DataFactory } from 'n3';
import type { StoreContext } from '../chatkit/store';
import type { RdfBindingRow, RdfEngineLike, RdfQuery, RdfQueryCacheScope, RdfSearchScope } from '../../storage/rdf/types';
import type {
  RunContextRetrievalInput,
  RunContextRetriever,
  RunRetrievedContext,
  RunRetrievedContextItem,
} from './RunExecutionBackend';

const { literal } = DataFactory;

export type RdfRunContextEmbedding =
  | number[]
  | {
    embedding: number[];
    model?: string;
  };

export interface RdfRunContextRetrieverOptions<TContext = StoreContext> {
  rdfEngine: RdfEngineLike;
  limit?: number;
  failOpen?: boolean;
  textWeight?: number;
  vectorWeight?: number;
  vectorModel?: string;
  sourcePrefix?: string | ((input: RunContextRetrievalInput<TContext>) => string | undefined);
  cacheScope?: RdfQueryCacheScope | ((input: RunContextRetrievalInput<TContext>) => RdfQueryCacheScope | undefined);
  embedding?: (input: RunContextRetrievalInput<TContext>) => Promise<RdfRunContextEmbedding | undefined>;
  buildQuery?: (input: RunContextRetrievalInput<TContext>, embedding?: RdfRunContextEmbedding) => RdfQuery | Promise<RdfQuery>;
}

/**
 * Product-level Run context retriever backed by SolidRdfEngine/PostgresRdfEngine.
 *
 * The retriever keeps RDF/text/vector lookup outside durable queue events and
 * returns runtime-neutral snippets that drivers can project into their own
 * prompt/session format.
 */
export class RdfRunContextRetriever<TContext = StoreContext> implements RunContextRetriever<TContext> {
  public constructor(private readonly options: RdfRunContextRetrieverOptions<TContext>) {}

  public async retrieve(input: RunContextRetrievalInput<TContext>): Promise<RunRetrievedContext | undefined> {
    const prompt = input.prompt.trim();
    if (!prompt) {
      return undefined;
    }

    try {
      const embedding = await this.options.embedding?.(input);
      const query = this.options.buildQuery
        ? await this.options.buildQuery(input, embedding)
        : this.buildDefaultQuery(input, embedding);
      const result = await this.options.rdfEngine.query(query);
      const items = result.bindings
        .map((row) => this.bindingToContextItem(row))
        .filter((item): item is RunRetrievedContextItem => item !== undefined)
        .slice(0, this.options.limit ?? 8);

      if (items.length === 0) {
        return undefined;
      }

      return {
        query: prompt,
        items,
        generatedAt: Math.floor(Date.now() / 1000),
        plan: result.metrics.plan,
      };
    } catch (error) {
      if (this.options.failOpen === false) {
        throw error;
      }
      return undefined;
    }
  }

  private buildDefaultQuery(
    input: RunContextRetrievalInput<TContext>,
    embedding?: RdfRunContextEmbedding,
  ): RdfQuery {
    const limit = this.options.limit ?? 8;
    const scope = this.searchScope(input);
    const cacheScope = this.cacheScope(input);
    const normalizedEmbedding = normalizeEmbedding(embedding);
    const hasVector = (normalizedEmbedding?.embedding.length ?? 0) > 0;
    const textWeight = this.options.textWeight ?? 0.55;
    const vectorWeight = this.options.vectorWeight ?? 0.45;
    const query: RdfQuery = {
      patterns: [],
      textSearch: [
        {
          query: input.prompt,
          scope,
          limit,
          source: 'source',
          chunk: 'textChunk',
          content: 'textContent',
          heading: 'textHeading',
          score: 'textScore',
          workspace: 'workspace',
          localPath: 'localPath',
          contentType: 'contentType',
        },
      ],
      select: [
        'source',
        'workspace',
        'localPath',
        'contentType',
        'textChunk',
        'textContent',
        'textHeading',
        'textScore',
      ],
      orderBy: [{ variable: 'textScore', direction: 'desc' }],
      limit,
      cache: cacheScope ? { scope: cacheScope } : undefined,
    };

    if (hasVector && normalizedEmbedding) {
      query.vectorSearch = [
        {
          embedding: normalizedEmbedding.embedding,
          vectorModel: normalizedEmbedding.model ?? this.options.vectorModel,
          scope,
          limit,
          source: 'source',
          chunk: 'vectorChunk',
          content: 'vectorContent',
          heading: 'vectorHeading',
          score: 'vectorScore',
          distance: 'vectorDistance',
          model: 'vectorModel',
        },
      ];
      query.binds = [
        {
          variable: 'fusionScore',
          expression: {
            type: 'add',
            expressions: [
              {
                type: 'multiply',
                expressions: [
                  { type: 'numericValue', expression: { type: 'variable', variable: 'textScore' } },
                  { type: 'term', term: literal(String(textWeight)) },
                ],
              },
              {
                type: 'multiply',
                expressions: [
                  { type: 'numericValue', expression: { type: 'variable', variable: 'vectorScore' } },
                  { type: 'term', term: literal(String(vectorWeight)) },
                ],
              },
            ],
          },
        },
      ];
      query.select = [
        ...(query.select ?? []),
        'vectorChunk',
        'vectorContent',
        'vectorHeading',
        'vectorScore',
        'vectorDistance',
        'vectorModel',
        'fusionScore',
      ];
      query.orderBy = [
        { variable: 'fusionScore', direction: 'desc' },
        { variable: 'source' },
      ];
    }

    return query;
  }

  private searchScope(input: RunContextRetrievalInput<TContext>): RdfSearchScope {
    const sourcePrefix = typeof this.options.sourcePrefix === 'function'
      ? this.options.sourcePrefix(input)
      : this.options.sourcePrefix;
    return {
      workspace: input.config.workspace,
      ...(sourcePrefix ? { sourcePrefix } : {}),
    };
  }

  private cacheScope(input: RunContextRetrievalInput<TContext>): RdfQueryCacheScope | undefined {
    return typeof this.options.cacheScope === 'function'
      ? this.options.cacheScope(input)
      : this.options.cacheScope;
  }

  private bindingToContextItem(row: RdfBindingRow): RunRetrievedContextItem | undefined {
    const text = termValue(row.textContent) || termValue(row.vectorContent);
    const source = termValue(row.source);
    if (!text || !source) {
      return undefined;
    }

    const fusionScore = termNumber(row.fusionScore);
    const textScore = termNumber(row.textScore);
    const vectorScore = termNumber(row.vectorScore);
    const heading = termValue(row.textHeading) || termValue(row.vectorHeading);
    const vectorDistance = termNumber(row.vectorDistance);
    const vectorModel = termValue(row.vectorModel);
    const metadata = compactRecord({
      textChunk: termValue(row.textChunk),
      vectorChunk: termValue(row.vectorChunk),
      textScore,
      vectorScore,
      vectorDistance,
      vectorModel,
      contentType: termValue(row.contentType),
    });
    return {
      kind: vectorScore !== undefined && textScore === undefined ? 'vector_chunk' : 'text_chunk',
      source,
      text,
      score: fusionScore ?? textScore ?? vectorScore,
      workspace: termValue(row.workspace),
      localPath: termValue(row.localPath),
      heading,
      metadata,
    };
  }
}

function normalizeEmbedding(input: RdfRunContextEmbedding | undefined): { embedding: number[]; model?: string } | undefined {
  if (!input) {
    return undefined;
  }
  if (Array.isArray(input)) {
    return { embedding: input };
  }
  return input;
}

function termValue(term: RdfBindingRow[string] | undefined): string | undefined {
  return term?.value || undefined;
}

function termNumber(term: RdfBindingRow[string] | undefined): number | undefined {
  const value = term?.value;
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function compactRecord(input: Record<string, unknown>): Record<string, unknown> | undefined {
  const entries = Object.entries(input).filter(([, value]) => value !== undefined);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}
