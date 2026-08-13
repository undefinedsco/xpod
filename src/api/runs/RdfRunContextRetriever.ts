import { DataFactory } from 'n3';
import type { StoreContext } from '../chatkit/store';
import { applyRdfAccessScope, type RdfAccessScope } from '../../storage/rdf/RdfAccessScope';
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
    provider?: string;
    model?: string;
    modelVersion?: string;
    inputKind?: string;
    projectionPolicyVersion?: string;
  };

export interface RdfRunContextRetrieverOptions<TContext = StoreContext> {
  rdfEngine: RdfEngineLike;
  limit?: number;
  /**
   * Keep normal product paths fail-closed so missing text/vector indexes are
   * exposed at startup or request execution instead of silently degrading Run
   * context. Tests and optional deployments can still opt into best-effort
   * retrieval explicitly.
   */
  failOpen?: boolean;
  textWeight?: number;
  vectorWeight?: number;
  vectorProvider?: string;
  vectorModel?: string;
  vectorModelVersion?: string;
  vectorInputKind?: string;
  vectorProjectionPolicyVersion?: string;
  sourcePrefix?: string | ((input: RunContextRetrievalInput<TContext>) => string | undefined);
  cacheScope?: RdfQueryCacheScope | ((input: RunContextRetrievalInput<TContext>) => RdfQueryCacheScope | undefined);
  accessScope?: RdfAccessScope | ((input: RunContextRetrievalInput<TContext>) => RdfAccessScope | undefined);
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
      const result = await this.options.rdfEngine.query(this.withAccessScope(query, input));
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
      if (this.options.failOpen === true) {
        return undefined;
      }
      throw error;
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
          sourceKey: 'sourceKey',
          retrievalPoint: 'retrievalPointKey',
          retrievalKind: 'retrievalKind',
          entityProvenance: 'entityProvenance',
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
        'sourceKey',
        'retrievalPointKey',
        'retrievalKind',
        'entityProvenance',
      ],
      orderBy: [{ variable: 'textScore', direction: 'desc' }],
      limit,
      cache: cacheScope ? { scope: cacheScope } : undefined,
    };

    if (hasVector && normalizedEmbedding) {
      query.vectorSearch = [
        {
          embedding: normalizedEmbedding.embedding,
          vectorProvider: normalizedEmbedding.provider ?? this.options.vectorProvider,
          vectorModel: normalizedEmbedding.model ?? this.options.vectorModel,
          vectorModelVersion: normalizedEmbedding.modelVersion ?? this.options.vectorModelVersion,
          vectorInputKind: normalizedEmbedding.inputKind ?? this.options.vectorInputKind,
          vectorProjectionPolicyVersion: normalizedEmbedding.projectionPolicyVersion ?? this.options.vectorProjectionPolicyVersion,
          scope,
          limit,
          source: 'vectorSource',
          chunk: 'vectorChunk',
          content: 'vectorContent',
          heading: 'vectorHeading',
          score: 'vectorScore',
          distance: 'vectorDistance',
          sourceKey: 'sourceKey',
          retrievalPoint: 'retrievalPointKey',
          provider: 'vectorProvider',
          model: 'vectorModel',
          modelVersion: 'vectorModelVersion',
          inputKind: 'vectorInputKind',
          projectionPolicyVersion: 'vectorProjectionPolicyVersion',
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
        'vectorProvider',
        'vectorModel',
        'vectorModelVersion',
        'vectorInputKind',
        'vectorProjectionPolicyVersion',
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

  private withAccessScope(query: RdfQuery, input: RunContextRetrievalInput<TContext>): RdfQuery {
    const accessScope = typeof this.options.accessScope === 'function'
      ? this.options.accessScope(input)
      : this.options.accessScope;
    if (!accessScope) {
      this.assertAccessScopeOptional(input);
      return query;
    }
    this.assertAccessScopeComplete(input, accessScope);
    return applyRdfAccessScope(query, accessScope);
  }

  private assertAccessScopeOptional(input: RunContextRetrievalInput<TContext>): void {
    if (isRemoteWorkspace(input.config.workspace)) {
      throw new Error('RDF Run context retrieval requires an access scope for remote Pod workspaces');
    }
  }

  private assertAccessScopeComplete(input: RunContextRetrievalInput<TContext>, accessScope: RdfAccessScope): void {
    if (!isRemoteWorkspace(input.config.workspace)) {
      return;
    }
    if (!accessScope.principal || !accessScope.version) {
      throw new Error('RDF Run context retrieval requires principal and permission version for remote Pod workspaces');
    }
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
    const vectorProvider = termValue(row.vectorProvider);
    const vectorModel = termValue(row.vectorModel);
    const vectorModelVersion = termValue(row.vectorModelVersion);
    const vectorInputKind = termValue(row.vectorInputKind);
    const vectorProjectionPolicyVersion = termValue(row.vectorProjectionPolicyVersion);
    const entityProvenance = parseJsonArray(termValue(row.entityProvenance));
    const metadata = compactRecord({
      untrustedContext: true,
      textChunk: termValue(row.textChunk),
      vectorChunk: termValue(row.vectorChunk),
      sourceKey: termValue(row.sourceKey),
      retrievalPointKey: termValue(row.retrievalPointKey),
      retrievalKind: termValue(row.retrievalKind),
      entityProvenance,
      textScore,
      vectorScore,
      vectorDistance,
      vectorProvider,
      vectorModel,
      vectorModelVersion,
      vectorInputKind,
      vectorProjectionPolicyVersion,
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

function isRemoteWorkspace(workspaceValue: string): boolean {
  try {
    const workspace = new URL(workspaceValue);
    return workspace.protocol === 'http:' || workspace.protocol === 'https:';
  } catch {
    return false;
  }
}

function normalizeEmbedding(input: RdfRunContextEmbedding | undefined): Exclude<RdfRunContextEmbedding, number[]> | undefined {
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

function parseJsonArray(value: string | undefined): unknown[] | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
