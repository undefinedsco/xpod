import { Readable } from 'node:stream';
import { getLoggerFor } from 'global-logger-factory';
import { pipeline } from 'node:stream/promises';
import { HttpHandler } from '@solid/community-server';
import type { HttpHandlerInput, HttpRequest, HttpResponse } from '@solid/community-server';
import {
  AS,
  SOLID_AS,
  NotFoundHttpError,
  NotImplementedHttpError,
  MethodNotAllowedHttpError,
  BadRequestHttpError,
  UnsupportedMediaTypeHttpError,
  IdentifierSetMultiMap,
  HttpError,
  RepresentationMetadata,
} from '@solid/community-server';
import { PERMISSIONS } from '@solidlab/policy-engine';
import type {
  ActivityEmitter,
  Credentials,
  CredentialsExtractor,
  PermissionReader,
  Authorizer,
  ResourceIdentifier,
} from '@solid/community-server';
import type { Term, Literal, Variable, Quad as RdfQuad } from '@rdfjs/types';
import { Writer, DataFactory } from 'n3';
import { Parser, Generator } from 'sparqljs';
import type {
  Update as SparqlUpdate,
  InsertDeleteOperation as SparqlInsertDeleteOperation,
  Quads as SparqlQuads,
  Pattern as SparqlPattern,
  GraphOrDefault as SparqlGraphOrDefault,
  IriTerm as SparqlIriTerm,
  Term as SparqlTerm,
  GraphQuads,
  UpdateOperation,
} from 'sparqljs';
import { SubgraphQueryEngine } from '../storage/sparql/SubgraphQueryEngine';
import type { SparqlLoadDocumentOptions, SparqlVoidOptions } from '../storage/sparql/SubgraphQueryEngine';
import {
  DisabledSparqlFeatureError,
  NativeSparqlExecutionError,
  UnsupportedSparqlQueryError,
  sparqlCorrectionForCapability,
} from '../storage/rdf/RdfSparqlBoundary';
import {
  METADATA_GRAPH_PREFIX,
  isMetadataGraphIri,
} from '../storage/rdf/RdfAccessScope';
import type { SparqlCorrection } from '../storage/rdf/RdfSparqlBoundary';
import type { RdfAccessScope } from '../storage/rdf/RdfAccessScope';
import { getIdentityDatabase } from '../identity/drizzle/db';
import { PodLookupRepository } from '../identity/drizzle/PodLookupRepository';
import { UsageRepository } from '../storage/quota/UsageRepository';
import { MixDataAccessor } from '../storage/accessors/MixDataAccessor';
import type { HierarchyLockingResourceStore } from '../storage/HierarchyLockingResourceStore';
import { createBandwidthThrottleTransform } from '../util/stream/BandwidthThrottleTransform';

/** Independent authorization reads are latency-bound; bound their in-flight count per request. */
const GRAPH_AUTHORIZATION_CONCURRENCY = 8;

/**
 * Runs `worker` over `items` with at most `limit` in flight, preserving input order.
 *
 * Contract: `worker` must not reject. This helper intentionally has no cancellation —
 * it is only used for read-only authorization checks whose call site (`canAuthorizeFor`)
 * already converts denials into `false`. If a throwing worker is ever wired in, the
 * first rejection surfaces while sibling runners finish; add an AbortSignal then.
 */
async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) {
        return;
      }
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * Authorization checks belong to one request and its credentials. Failed checks are
 * removed so a retry can re-evaluate permissions; later requests always start fresh.
 */
type AuthorizationMemo = Map<string, Promise<void>>;

const ALLOWED_METHODS = [ 'GET', 'POST', 'OPTIONS' ];
const MODEL_COLLECTION_SUFFIX = '/settings/providers/-/sparql';
const SETTINGS_COLLECTION_SUFFIX = '/settings/-/sparql';

interface QueryRequest {
  basePath: string;
  baseUrl: string;  // Full URL for authorization (origin + basePath)
  sourceUri?: string;
  defaultDataset: 'exactSource' | 'scopedUnion';
  query: string;
  origin: string;
  method: string;
  ingressBytes: number;
}

/**
 * A read that explicitly targets the metadata facets of this endpoint. Facets
 * are the literal `meta:` graphs of resources under the same base; they are
 * exact graphs and are authorized as their subject resource.
 */
interface MetadataReadPlan {
  kind: 'explicit' | 'collection';
  basePath: string;
  graphIris: string[];
  graphVariable?: string;
  subjectVariable?: string;
  /**
   * Collection queries may aggregate and therefore not project the graph/subject
   * variables (SPARQL forbids ungrouped projection). The query-level correlation
   * filter plus the pinned authorized graph set remain mandatory either way; the
   * per-row guard only runs when the variables are actually returned.
   */
  rowGuard: boolean;
}

interface SubgraphSparqlHttpHandlerOptions {
  /** @deprecated Use sidecarPath instead */
  resourceSuffix?: string;
  /** @deprecated Use sidecarPath instead */
  containerSuffix?: string;
  /** Sidecar API path segment, default: '/-/sparql' */
  sidecarPath?: string;
  identityDbUrl?: string;
  usageDbUrl?: string;
  defaultAccountBandwidthLimitBps?: number | null;
}

type UsageContext = {
  accountId: string;
  podId: string;
};

interface SparqlErrorResponse {
  error: {
    code: string;
    message: string;
    capability?: string;
    hint?: string;
    correction?: SparqlCorrection;
  };
}

interface TrustedModelCollectionTarget {
  basePath: string;
  baseUrl: string;
  sourceUri?: string;
  defaultDataset: 'exactSource' | 'scopedUnion';
  origin: string;
  query: string;
}

interface UpdateAccessPlan {
  hasInsert: boolean;
  hasDelete: boolean;
  needsReadScope: boolean;
  readTargets: Set<string>;
  writeTargets: Map<string, Set<string>>;
  /** Per written graph: which kind of change the update applies to that graph. */
  targetEffects: Map<string, UpdateTargetEffect>;
  loadDocuments: LoadDocumentPlan[];
  clearGraphs: string[];
  graphCopies: GraphCopyPlan[];
}

/**
 * What a SPARQL update does to one written graph (= one affected document).
 *
 * Every graph passed to {@link SubgraphSparqlHttpHandler.addWriteTarget} is a written document, so a
 * target with all flags false is a plain partial delete. The flags plus the pre-update existence of
 * the document decide the ActivityStream term (see {@link SubgraphSparqlHttpHandler.resolveActivity}).
 */
interface UpdateTargetEffect {
  /** An insert-family operation (`INSERT DATA`, `INSERT … WHERE`, `LOAD`, `ADD`, `COPY`) wrote data. */
  addedData: boolean;
  /** The graph is emptied as a whole (`CLEAR`, `DROP`, `MOVE` source, `COPY` target reset). */
  removedAllData: boolean;
  /** `CREATE [SILENT] GRAPH` targets this graph. */
  createdGraph: boolean;
}

/** ActivityStream term chosen for a SPARQL-sidecar write. */
type UpdateActivity = typeof AS.terms.Create | typeof AS.terms.Update | typeof AS.terms.Delete;

/** One `changed` event the sidecar will emit after a successful write. */
interface PendingActivity {
  identifier: ResourceIdentifier;
  activity: UpdateActivity;
}

interface LoadDocumentPlan {
  sourceUri: string;
  targetGraph: string;
  silent?: boolean;
}

interface GraphCopyPlan {
  operation: 'add' | 'copy' | 'move';
  sourceGraph: string;
  targetGraph: string;
}

export class SubgraphSparqlHttpHandler extends HttpHandler {
  protected readonly logger = getLoggerFor(this);
  private readonly engine: SubgraphQueryEngine;
  private readonly credentialsExtractor: CredentialsExtractor;
  private readonly permissionReader: PermissionReader;
  private readonly authorizer: Authorizer;
  private readonly sidecarPath: string;
  private readonly podLookup?: PodLookupRepository;
  private readonly usageRepo?: UsageRepository;
  private readonly defaultBandwidthLimit?: number | null;
  private readonly updateAuthority?: MixDataAccessor;
  private readonly emitter?: ActivityEmitter;
  private readonly generator = new Generator();

  private static readonly XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';

  public constructor(
    queryEngine: SubgraphQueryEngine,
    credentialsExtractor: CredentialsExtractor,
    permissionReader: PermissionReader,
    authorizer: Authorizer,
    options: SubgraphSparqlHttpHandlerOptions = {},
    updateAuthority?: MixDataAccessor,
    emitter?: ActivityEmitter,
    private readonly mutationStore?: HierarchyLockingResourceStore,
  ) {
    super();
    this.engine = queryEngine;
    this.credentialsExtractor = credentialsExtractor;
    this.permissionReader = permissionReader;
    this.authorizer = authorizer;
    this.sidecarPath = options.sidecarPath ?? '/-/sparql';
    this.defaultBandwidthLimit = this.normalizeLimit(options.defaultAccountBandwidthLimitBps);
    this.updateAuthority = updateAuthority;
    this.emitter = emitter;

    // Identity DB is used for pod lookup (to resolve accountId/podId from URL)
    if (options.identityDbUrl) {
      const db = getIdentityDatabase(options.identityDbUrl);
      this.podLookup = new PodLookupRepository(db);
    }

    // Usage DB can be separate from identity DB (decoupled usage tracking)
    // NOTE: UsageRepository only supports PostgreSQL. SQLite is skipped.
    const usageDbUrl = options.usageDbUrl ?? options.identityDbUrl;
    if (usageDbUrl && !this.isSqliteUrl(usageDbUrl)) {
      const usageDb = getIdentityDatabase(usageDbUrl);
      this.usageRepo = new UsageRepository(usageDb);
    }
  }

  public override async canHandle({ request }: HttpHandlerInput): Promise<void> {
    const path = this.parseUrl(request).pathname;
    // Match /-/sparql pattern: /alice/-/sparql or /alice/photos/-/sparql
    if (!path.includes(this.sidecarPath)) {
      throw new NotImplementedHttpError('Request is not targeting a subgraph SPARQL endpoint.');
    }
  }

  public override async handle({ request, response }: HttpHandlerInput): Promise<void> {
    const method = (request.method ?? 'GET').toUpperCase();

    if (method === 'OPTIONS') {
      this.writeOptions(response);
      return;
    }

    if (!ALLOWED_METHODS.includes(method)) {
      throw new MethodNotAllowedHttpError(ALLOWED_METHODS);
    }

    try {
      const queryRequest = await this.extractQuery(request, method);
      const context = await this.resolveUsageContext(queryRequest.basePath);
      await this.recordBandwidth(context, queryRequest.ingressBytes, 0);
      const parser = new Parser({ baseIRI: queryRequest.baseUrl });
      const parsed = parser.parse(queryRequest.query);

      if (parsed.type === 'update') {
        await this.executeUpdate(queryRequest, parsed, request, response, context);
        return;
      }

      const queryType = parsed.queryType ?? 'SELECT';
      const metadataPlan = queryType === 'SELECT'
        ? this.classifyMetadataRead(parsed, queryRequest.baseUrl)
        : undefined;
      // Only the explicit SELECT path authorizes each facet's subject resource.
      // Every other shape (ASK/CONSTRUCT/DESCRIBE, or a SELECT the classifier did
      // not accept) must fail closed instead of falling through to ordinary
      // execution, where the metadata alias has no ACL decision behind it.
      if (!metadataPlan) {
        const unsupported = this.unsupportedMetadataSignal(parsed, queryRequest.baseUrl);
        if (unsupported) {
          throw new BadRequestHttpError(unsupported);
        }
      }

      switch (queryType) {
        case 'SELECT':
          if (metadataPlan) {
            await this.executeMetadataSelect(request, queryRequest, metadataPlan, response, context);
          } else {
            await this.executeSelect(request, queryRequest, response, context);
          }
          break;
        case 'ASK':
          await this.executeAsk(request, queryRequest, response, context);
          break;
        case 'CONSTRUCT':
        case 'DESCRIBE':
          await this.executeConstruct(request, queryRequest, response, context);
          break;
        default:
          throw new BadRequestHttpError(`Unsupported SPARQL query type: ${queryType}`);
      }
    } catch (error: unknown) {
      // Handle HttpErrors with proper status codes
      if (error instanceof HttpError) {
        const errorName = error.name || error.constructor.name || 'HttpError';
        const errorMessage = error.message || 'No message';
        this.logger.error(`SPARQL sidecar error ${error.statusCode} (${this.getRequestId(request)}): ${errorName} - ${errorMessage}`);
        this.sendErrorResponse(request, response, error.statusCode, errorMessage, {
          error: {
            code: `http.${error.statusCode}`,
            message: errorMessage,
          },
        });
        return;
      }
      if (error instanceof DisabledSparqlFeatureError) {
        this.logger.warn(`SPARQL sidecar disabled feature (${this.getRequestId(request)}): ${error.message}`);
        this.sendErrorResponse(request, response, 403, error.message, {
          error: {
            code: 'rdf.sparql.disabled_feature',
            message: error.message,
            capability: 'sparql.federation.service',
            hint: 'Disable SERVICE federation for server-owned Pod queries, or execute it from a trusted client-side/federated query layer.',
            correction: sparqlCorrectionForCapability('sparql.federation.service'),
          },
        });
        return;
      }
      if (error instanceof UnsupportedSparqlQueryError) {
        this.logger.warn(`SPARQL sidecar unsupported query (${this.getRequestId(request)}): ${error.message}`);
        this.sendErrorResponse(request, response, 400, error.message, {
          error: {
            code: error.code,
            message: error.message,
            capability: error.capability,
            hint: error.hint,
            correction: error.correction,
          },
        });
        return;
      }
      if (error instanceof NativeSparqlExecutionError) {
        this.logger.error(`SPARQL sidecar native execution error (${this.getRequestId(request)}): ${error.message}`);
        this.sendErrorResponse(request, response, 500, error.message, {
          error: {
            code: error.code,
            message: error.message,
          },
        });
        return;
      }
      // Re-throw unknown errors for CSS error handling
      this.logger.error(`SPARQL sidecar unexpected error (${this.getRequestId(request)}): ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  private sendErrorResponse(
    request: HttpRequest,
    response: HttpResponse,
    statusCode: number,
    message: string,
    jsonPayload: SparqlErrorResponse,
  ): void {
    response.statusCode = statusCode;
    if (this.acceptsJson(request)) {
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.end(JSON.stringify(jsonPayload));
      return;
    }
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    response.end(message);
  }

  private acceptsJson(request: HttpRequest): boolean {
    const accept = request.headers.accept;
    const values = Array.isArray(accept) ? accept : [ accept ];
    return values.some(value => typeof value === 'string' && /\bapplication\/json\b/i.test(value));
  }

  private classifyMetadataRead(parsed: any, baseUrl: string): MetadataReadPlan | undefined {
    const metadataPrefix = `${METADATA_GRAPH_PREFIX}${baseUrl}`;
    if ((parsed.from?.default?.length ?? 0) > 0 || (parsed.from?.named?.length ?? 0) > 0) {
      return undefined;
    }
    const graphIris: string[] = [];
    const graphVariables = new Set<string>();
    const filters: any[] = [];
    const topLevelFilters: any[] = [];
    const graphTriples: Array<{ subject?: any; predicate?: any; object?: any; pattern: any }> = [];
    let unNamed = false;
    let unsupportedShape: string | undefined;

    const visit = (patterns: any[] | undefined, insideGraph: boolean, branchDepth = 0): void => {
      for (const pattern of patterns ?? []) {
        if (!pattern || typeof pattern !== 'object') {
          continue;
        }
        if (pattern.type === 'graph') {
          if (insideGraph) {
            unsupportedShape ??= 'Nested GRAPH patterns are not supported for metadata reads.';
            continue;
          }
          if (pattern.name?.termType === 'NamedNode') {
            graphIris.push(pattern.name.value);
          } else if (pattern.name?.termType === 'Variable') {
            graphVariables.add(pattern.name.value);
          } else {
            unsupportedShape ??= 'Metadata reads require a named or variable GRAPH.';
            continue;
          }
          visit(pattern.patterns, true, branchDepth);
          continue;
        }
        if (pattern.type === 'bgp') {
          if (!insideGraph) {
            unNamed = true;
          } else if (pattern.triples) {
            for (const triple of pattern.triples) {
              graphTriples.push({ ...triple, pattern });
            }
          }
          continue;
        }
        if (pattern.type === 'optional' || pattern.type === 'group' || pattern.type === 'union') {
          if (!insideGraph) unNamed = true;
          const nested = pattern.type === 'union'
            ? (pattern.patterns ?? []).flatMap((branch: any) => branch.patterns ?? [branch])
            : pattern.patterns;
          // A filter inside a UNION/OPTIONAL branch constrains only that branch, so it
          // cannot prove ownership for the other branches. Only a filter that applies
          // to the whole pattern group (branchDepth 0) may satisfy the check.
          visit(nested, insideGraph, pattern.type === 'group' ? branchDepth : branchDepth + 1);
          continue;
        }
        if (pattern.type === 'filter') {
          filters.push(pattern);
          if (branchDepth === 0) {
            topLevelFilters.push(pattern);
          }
          continue;
        }
        if (pattern.type === 'bind') {
          // A top-level BIND computes a term; it does not read the data namespace.
          continue;
        }
        if (!insideGraph && (pattern.type === 'minus' || pattern.type === 'exists' || pattern.type === 'values')) {
          unNamed = true;
        }
      }
    };

    visit(parsed.where, false);

    // Ordinary SELECTs (including ordinary GRAPH/?g data queries) never enter the
    // metadata path. Shape errors are only reported after a metadata signal was found.
    const namedMetadata = graphIris.filter((iri) => isMetadataGraphIri(iri) && iri.startsWith(metadataPrefix));
    const graphVariable = graphVariables.size === 1 ? [ ...graphVariables ][0] : undefined;
    const boundedVariable = graphVariable !== undefined
      && this.hasBoundedMetadataGraphFilter(topLevelFilters, graphVariable, metadataPrefix);
    const metadataSignal = namedMetadata.length > 0 || boundedVariable;
    if (!metadataSignal) {
      const outOfBaseMetadata = graphIris.find((iri) => isMetadataGraphIri(iri));
      if (graphIris.length === 0 && graphVariables.size === 0) {
        return undefined;
      }
      if (outOfBaseMetadata) {
        throw new BadRequestHttpError(`Metadata graph ${outOfBaseMetadata} is outside ${metadataPrefix}.`);
      }
      return undefined;
    }
    if (unsupportedShape) {
      throw new BadRequestHttpError(unsupportedShape);
    }
    const subjectVariable = graphVariable
      ? this.resolveMetadataSubjectVariable(graphTriples, parsed.where, filters, graphVariable)
      : undefined;
    if (unNamed) {
      throw new BadRequestHttpError('Metadata graph patterns cannot be mixed with un-named data patterns; issue a metadata-only query.');
    }
    if (graphIris.length > 0) {
      if (graphVariables.size > 0) {
        throw new BadRequestHttpError('Metadata reads cannot mix explicit graphs with a graph variable.');
      }
      for (const iri of graphIris) {
        if (!isMetadataGraphIri(iri)) {
          throw new BadRequestHttpError('Metadata graph reads cannot be mixed with data graph reads.');
        }
        if (!iri.startsWith(metadataPrefix)) {
          throw new BadRequestHttpError(`Metadata graph ${iri} is outside ${metadataPrefix}.`);
        }
      }
      return { kind: 'explicit', basePath: baseUrl, graphIris, rowGuard: false };
    }
    if (!graphVariable) {
      throw new BadRequestHttpError('Metadata reads support at most one graph variable.');
    }
    if (!subjectVariable) {
      throw new BadRequestHttpError('Metadata collection reads require a subject variable bound inside GRAPH.');
    }
    const projected = new Set<string>((parsed.variables ?? [])
      .map((variable: any) => variable?.termType === 'Variable' ? variable.value : undefined)
      .filter((value: unknown): value is string => typeof value === 'string'));
    // Grouped/aggregate SELECTs legitimately project neither the graph nor the
    // subject (SPARQL requires every projected variable to be grouped). The
    // ownership correlation is required in the query text regardless, and the
    // physical scope is pinned to the authorized graph snapshot, so an aggregate
    // still only sees own facets.
    const rowGuard = projected.has(graphVariable) && projected.has(subjectVariable);
    if (!this.hasMetadataGraphSubjectBinding(topLevelFilters, graphVariable, subjectVariable)
      && !this.hasMetadataGraphExpectedBind(parsed.where, topLevelFilters, graphVariable, subjectVariable)) {
      throw new BadRequestHttpError(
        'Metadata collection reads must bind graph to subject in the query: '
        + `FILTER(STR(?${subjectVariable}) = STRAFTER(STR(?${graphVariable}), "meta:")) `
        + 'or BIND(IRI(CONCAT("meta:", STR(?subject))) AS ?expected) + FILTER(?graph = ?expected) before ORDER/LIMIT.',
      );
    }
    return { kind: 'collection', basePath: baseUrl, graphIris: [], graphVariable, subjectVariable, rowGuard };
  }

  /**
   * Detect metadata access in a query shape that has no per-subject authorization
   * (ASK/CONSTRUCT/DESCRIBE, or a SELECT the metadata classifier rejected).
   * Returning a reason makes the request fail closed with an explicit 400 rather
   * than silently evaluating against data graphs only.
   */
  private unsupportedMetadataSignal(parsed: any, baseUrl: string): string | undefined {
    const metadataPrefix = `${METADATA_GRAPH_PREFIX}${baseUrl}`;
    const graphVariables = new Set<string>();
    const filters: any[] = [];
    let explicit: string | undefined;

    const visit = (patterns: any[] | undefined): void => {
      for (const pattern of patterns ?? []) {
        if (!pattern || typeof pattern !== 'object') {
          continue;
        }
        if (pattern.type === 'graph') {
          if (pattern.name?.termType === 'NamedNode' && isMetadataGraphIri(pattern.name.value)) {
            explicit ??= pattern.name.value;
          } else if (pattern.name?.termType === 'Variable') {
            graphVariables.add(pattern.name.value);
          }
          visit(pattern.patterns);
          continue;
        }
        if (pattern.type === 'bgp' || pattern.type === 'values' || pattern.type === 'bind') {
          continue;
        }
        if (pattern.type === 'filter') {
          filters.push(pattern);
          continue;
        }
        if (pattern.type === 'union' || pattern.type === 'optional' || pattern.type === 'group') {
          visit(pattern.patterns);
          continue;
        }
        if (pattern.type === 'query') {
          // A nested SELECT/ASK reads the same store; descend so a facet inside a
          // subquery is rejected here instead of quietly evaluating to empty.
          visit(pattern.where);
          continue;
        }
        if (pattern.type === 'service') {
          visit(pattern.patterns);
          continue;
        }
      }
    };
    visit(parsed.where);

    if (explicit) {
      return `Metadata graph ${explicit} is only readable through an explicit metadata SELECT; `
        + 'this query shape has no per-resource authorization.';
    }
    for (const graphVariable of graphVariables) {
      if (this.hasBoundedMetadataGraphFilter(filters, graphVariable, metadataPrefix)) {
        return 'Metadata collection reads are only supported as SELECT with the graph-to-subject binding; '
          + 'this query shape has no per-resource authorization.';
      }
    }
    return undefined;
  }

  /**
   * Derive the subject variable structurally: the first variable that appears in
   * the subject slot of a triple inside the metadata GRAPH, preferring one that
   * also occurs in the projected variables. Variable names carry no semantics.
   */
  private resolveMetadataSubjectVariable(
    graphTriples: Array<{ subject?: any }>,
    where: any[] | undefined,
    filters: any[],
    graphVariable: string,
  ): string | undefined {
    const subjects: string[] = [];
    for (const triple of graphTriples) {
      const subject = triple.subject;
      if (subject?.termType === 'Variable'
        && subject.value !== graphVariable
        && !subjects.includes(subject.value)) {
        subjects.push(subject.value);
      }
    }
    // Prefer the subject the query explicitly ties to the graph.
    const bound = subjects.find((candidate) => this.hasMetadataGraphSubjectBinding(filters, graphVariable, candidate));
    if (bound) {
      return bound;
    }
    if (subjects.length > 0) {
      return subjects[0];
    }
    // A query may bind the metadata subject through IRI(CONCAT("meta:", STR(?s)))
    // instead of a subject-slot triple; accept exactly one such structural bind.
    const dynamicSubjects = new Set<string>();
    for (const pattern of where ?? []) {
      if (pattern?.type !== 'bind' || pattern.variable?.termType !== 'Variable') {
        continue;
      }
      const expr = pattern.expression;
      const boundExpr = expr?.type === 'operation' && expr.operator === 'iri' ? expr.args?.[0] : expr;
      const concat = boundExpr?.type === 'operation' && boundExpr.operator === 'concat' ? boundExpr.args ?? [] : [];
      for (const arg of concat) {
        if (arg?.type === 'operation' && arg.operator === 'str' && arg.args?.[0]?.termType === 'Variable') {
          dynamicSubjects.add(arg.args[0].value);
        }
      }
    }
    return dynamicSubjects.size === 1 ? [ ...dynamicSubjects ][0] : undefined;
  }

  /**
   * Compatible query-level binding form: BIND(IRI(CONCAT("meta:", STR(?s))) AS
   * ?expected) plus FILTER(?graph = ?expected), still evaluated before
   * ORDER/LIMIT/OFFSET. Root's canonical form is the STRAFTER filter; this alias
   * is accepted so an existing ORM builder does not have to rewrite first.
   */
  private hasMetadataGraphExpectedBind(
    where: any[] | undefined,
    filters: any[],
    graphVariable: string,
    subjectVariable: string,
  ): boolean {
    const expected = new Set<string>();
    for (const pattern of where ?? []) {
      if (pattern?.type !== 'bind' || pattern.variable?.termType !== 'Variable') {
        continue;
      }
      const expr = pattern.expression;
      const bound = expr?.type === 'operation' && expr.operator === 'iri' ? expr.args?.[0] : expr;
      if (bound?.type !== 'operation' || bound.operator !== 'concat') {
        continue;
      }
      const args = bound.args ?? [];
      const prefix = args[0];
      const strArg = args[1];
      const inner = strArg?.type === 'operation' && strArg.operator === 'str' ? strArg.args?.[0] : undefined;
      if (prefix?.termType === 'Literal'
        && prefix.value === METADATA_GRAPH_PREFIX
        && inner?.termType === 'Variable'
        && inner.value === subjectVariable) {
        expected.add(pattern.variable.value);
      }
    }
    if (expected.size === 0) {
      return false;
    }
    return filters.some((filter) => {
      const expression = filter.expression;
      if (expression?.type !== 'operation' || expression.operator !== '=') {
        return false;
      }
      const [ left, right ] = expression.args ?? [];
      const vars = [ left, right ].filter((arg: any) => arg?.termType === 'Variable').map((arg: any) => arg.value);
      return vars.length === 2
        && vars.includes(graphVariable)
        && vars.some((name: string) => expected.has(name));
    });
  }

  private hasBoundedMetadataGraphFilter(filters: any[], graphVariable: string, metadataPrefix: string): boolean {
    return filters.some((filter) => {
      const expression = filter.expression;
      if (expression?.type !== 'operation' || expression.operator !== 'strstarts') {
        return false;
      }
      const [ left, right ] = expression.args ?? [];
      const inner = left?.type === 'operation' && left.operator === 'str' ? left.args?.[0] : undefined;
      return inner?.termType === 'Variable'
        && inner.value === graphVariable
        && right?.termType === 'Literal'
        && right.value === metadataPrefix;
    });
  }

  /**
   * Root requires graph<->subject binding to be enforced by the query before
   * ORDER/LIMIT/OFFSET, not only by a post-filter. Accept the exact
   * `FILTER(STR(?subject) = STRAFTER(STR(?metadataGraph), "meta:"))` form and
   * fail closed if a collection query omits it.
   */
  private hasMetadataGraphSubjectBinding(
    filters: any[],
    graphVariable: string,
    subjectVariable: string,
  ): boolean {
    return filters.some((filter) => {
      const expression = filter.expression;
      if (expression?.type !== 'operation' || expression.operator !== '=') {
        return false;
      }
      const [ left, right ] = expression.args ?? [];
      const isSubjectStr = left?.type === 'operation'
        && left.operator === 'str'
        && left.args?.[0]?.termType === 'Variable'
        && left.args[0].value === subjectVariable;
      const isStrafter = right?.type === 'operation'
        && right.operator === 'strafter'
        && right.args?.[0]?.type === 'operation'
        && right.args[0].operator === 'str'
        && right.args[0].args?.[0]?.termType === 'Variable'
        && right.args[0].args[0].value === graphVariable
        && right.args?.[1]?.termType === 'Literal'
        && right.args[1].value === METADATA_GRAPH_PREFIX;
      return isSubjectStr && isStrafter;
    });
  }

  private async executeMetadataSelect(
    request: HttpRequest,
    queryRequest: QueryRequest,
    plan: MetadataReadPlan,
    response: HttpResponse,
    context: UsageContext | undefined,
  ): Promise<void> {
    if (typeof this.engine.queryMetadataBindings !== 'function') {
      throw new UnsupportedSparqlQueryError('This SPARQL engine does not expose metadata facet reads.');
    }
    const credentials = await this.credentialsExtractor.handleSafe(request);
    const memo: AuthorizationMemo = new Map();
    const allowed = new Map<string, boolean>();
    const authorize = async (resource: string): Promise<void> => {
      if (!allowed.has(resource)) {
        allowed.set(resource, await this.canAuthorizeFor(resource, credentials, [ PERMISSIONS.Read ], memo));
      }
    };
    let existingGraphs: Set<string> | undefined;
    if (plan.kind === 'explicit') {
      // A metadata graph that was never written is a valid empty range, not an
      // error: only authorize (and later pin) graphs that the index actually has.
      existingGraphs = await this.engine.listMetadataGraphs(queryRequest.baseUrl, {
        basePath: `${METADATA_GRAPH_PREFIX}${queryRequest.baseUrl}`,
        mode: 'read',
      });
      for (const graph of plan.graphIris) {
        if (!existingGraphs.has(graph)) {
          continue;
        }
        await authorize(this.metadataResourceForGraph(graph, plan.basePath));
      }
    } else {
      const listed = await this.engine.listMetadataGraphs(queryRequest.baseUrl, {
        basePath: `${METADATA_GRAPH_PREFIX}${queryRequest.baseUrl}`,
        mode: 'read',
      });
      for (const graph of listed) {
        let resource: string;
        try {
          resource = this.metadataResourceForGraph(graph, plan.basePath);
        } catch {
          continue;
        }
        await authorize(resource);
      }
    }

    // Pin the physical graph scope to the snapshot that was actually authorized.
    // A graph created after listing/authorization is therefore excluded by the
    // engine before ORDER/LIMIT/aggregates, not merely by the row post-filter.
    // An empty authorized snapshot fails closed without a query round trip.
    const authorizedGraphs = [ ...allowed.entries() ]
      .filter(([ , value ]) => value)
      .map(([ resource ]) => `${METADATA_GRAPH_PREFIX}${resource}`)
      .filter((graph) => plan.kind !== 'explicit' || (existingGraphs?.has(graph) ?? false))
      .sort();
    if (authorizedGraphs.length === 0) {
      await this.sendPayload(
        response,
        JSON.stringify({ head: { vars: [] }, results: { bindings: [] } }),
        'application/sparql-results+json; charset=utf-8',
        context,
      );
      return;
    }
    const scope: RdfAccessScope = {
      basePath: `${METADATA_GRAPH_PREFIX}${queryRequest.baseUrl}`,
      mode: 'read',
      ...(credentials.agent?.webId ? { principal: credentials.agent.webId } : {}),
      allowedGraphUrls: authorizedGraphs,
    };

    const results: Record<string, unknown>[] = [];
    const seenVars = new Set<string>();
    const explicitDenied = plan.kind === 'explicit'
      && [ ...allowed.values() ].some((value) => !value);
    if (explicitDenied) {
      await this.sendPayload(
        response,
        JSON.stringify({ head: { vars: [] }, results: { bindings: [] } }),
        'application/sparql-results+json; charset=utf-8',
        context,
      );
      return;
    }
    const stream = await this.engine.queryMetadataBindings(queryRequest.query, queryRequest.baseUrl, scope);
    for await (const binding of stream as AsyncIterable<any>) {
      if (plan.rowGuard && !this.metadataRowAllowed(binding, plan, allowed)) {
        continue;
      }
      const row: Record<string, unknown> = {};
      for (const [ variable, term ] of binding) {
        const name = typeof variable === 'string' ? variable : variable.value;
        row[name] = this.termToJson(term);
        seenVars.add(name);
      }
      results.push(row);
    }
    const payload = { head: { vars: [ ...seenVars ] }, results: { bindings: results } };
    await this.sendPayload(response, JSON.stringify(payload), 'application/sparql-results+json; charset=utf-8', context);
  }

  private metadataResourceForGraph(graph: string, baseUrl: string): string {
    if (!isMetadataGraphIri(graph) || !graph.startsWith(`${METADATA_GRAPH_PREFIX}${baseUrl}`)) {
      throw new BadRequestHttpError(`Metadata graph ${graph} is outside ${baseUrl}.`);
    }
    return graph.slice(METADATA_GRAPH_PREFIX.length);
  }

  private metadataRowAllowed(binding: any, plan: MetadataReadPlan, allowed: Map<string, boolean>): boolean {
    const graphTerm = binding.get(plan.graphVariable);
    const resourceTerm = binding.get(plan.subjectVariable);
    if (graphTerm?.termType !== 'NamedNode' || resourceTerm?.termType !== 'NamedNode') {
      return false;
    }
    return graphTerm.value === `${METADATA_GRAPH_PREFIX}${resourceTerm.value}`
      && resourceTerm.value.startsWith(plan.basePath)
      && allowed.get(resourceTerm.value) === true;
  }

  private async executeSelect(
    request: HttpRequest,
    { query, basePath, baseUrl, sourceUri, defaultDataset }: QueryRequest,
    response: HttpResponse,
    context: UsageContext | undefined,
    trusted = false,
  ): Promise<void> {
    // Trusted internal requests bypass user credentials and ACL lookups, but they
    // still need an owner-scoped RDF access boundary.  Without this scope the
    // query engine can federate across the whole quadstore and return model IRIs
    // from another Pod; the caller would then try to fetch those foreign
    // documents through the owner-locked bridge.
    const accessScope = trusted
      ? this.trustedReadAccessScope(baseUrl)
      : await this.resolveReadAccessScope(baseUrl, request);

    let vars: string[] = [];
    const results: Record<string, unknown>[] = [];
    const seenVars = new Set<string>();

    const bindingsStream: any = await this.engine.queryBindings(
      query,
      baseUrl,
      accessScope,
      { ...(sourceUri === undefined ? {} : { sourceUri }), defaultDataset },
    );
    const metadata = typeof bindingsStream.metadata === 'function' ? await bindingsStream.metadata() : undefined;
    vars = metadata?.variables?.map((variable: Variable): string => variable.value) ?? [];

    for await (const binding of bindingsStream as AsyncIterable<any>) {
      const row: Record<string, unknown> = {};
      for (const [ variable, term ] of binding) {
        const name = typeof variable === 'string' ? variable : variable.value;
        row[name] = this.termToJson(term);
        seenVars.add(name);
      }
      results.push(row);
    }

    if (vars.length === 0 && seenVars.size > 0) {
      vars = Array.from(seenVars);
    }

    const payload = {
      head: { vars },
      results: { bindings: results },
    };

    await this.sendPayload(response, JSON.stringify(payload), 'application/sparql-results+json; charset=utf-8', context);
  }

  private async executeAsk(request: HttpRequest, { query, basePath, baseUrl, sourceUri, defaultDataset }: QueryRequest, response: HttpResponse, context: UsageContext | undefined): Promise<void> {
    const accessScope = await this.resolveReadAccessScope(baseUrl, request);
    const result = await this.engine.queryBoolean(
      query,
      baseUrl,
      accessScope,
      { ...(sourceUri === undefined ? {} : { sourceUri }), defaultDataset },
    );
    const payload = {
      head: {},
      boolean: result,
    };
    await this.sendPayload(response, JSON.stringify(payload), 'application/sparql-results+json; charset=utf-8', context);
  }

  private async executeConstruct(request: HttpRequest, { query, basePath, baseUrl, sourceUri, defaultDataset }: QueryRequest, response: HttpResponse, context: UsageContext | undefined): Promise<void> {
    const accessScope = await this.resolveReadAccessScope(baseUrl, request);
    const quadStream = await this.engine.queryQuads(
      query,
      baseUrl,
      accessScope,
      { ...(sourceUri === undefined ? {} : { sourceUri }), defaultDataset },
    );
    const writer = new Writer({ format: 'N-Quads' });

    for await (const quad of quadStream) {
      writer.addQuad(quad);
    }

    const nquads = await new Promise<string>((resolve, reject) => {
      writer.end((error, result) => {
        if (error) {
          reject(error);
        } else {
          resolve(result);
        }
      });
    });

    await this.sendPayload(response, nquads, 'application/n-quads; charset=utf-8', context);
  }

  private async executeUpdate(
    queryRequest: QueryRequest,
    parsed: SparqlUpdate,
    request: HttpRequest,
    response: HttpResponse,
    context: UsageContext | undefined,
    trusted = false,
  ): Promise<void> {
    if (queryRequest.method !== 'POST') {
      throw new MethodNotAllowedHttpError([ 'POST' ]);
    }

    const accessPlan = this.inspectUpdateGraphs(parsed, queryRequest.baseUrl);
    const modes: string[] = [];
    if (accessPlan.needsReadScope) {
      modes.push(PERMISSIONS.Read);
    }
    if (accessPlan.hasInsert) {
      modes.push(PERMISSIONS.Append);
    }
    if (accessPlan.hasDelete) {
      modes.push(PERMISSIONS.Delete);
    }
    const authMemo: AuthorizationMemo = new Map();
    const credentials = trusted ? undefined : await this.authorizeFor(queryRequest.baseUrl, request, modes, authMemo);

    if (!trusted && credentials) {
      for (const source of accessPlan.readTargets) {
        if (source === queryRequest.baseUrl) {
          continue;
        }
        await this.authorizeIdentifier(source, credentials, [ PERMISSIONS.Read ], authMemo);
      }

      for (const [ graph, graphModes ] of accessPlan.writeTargets) {
        const resourceUrl = this.resourceUrlForGraphValue(graph);
        if (resourceUrl === queryRequest.baseUrl) {
          continue;
        }
        await this.authorizeIdentifier(resourceUrl, credentials, [...graphModes], authMemo);
      }
    }

    const readAccessScope = accessPlan.needsReadScope
      ? trusted
        ? this.trustedReadAccessScope(queryRequest.baseUrl)
        : await this.resolveReadAccessScopeForCredentials(queryRequest.baseUrl, credentials!, authMemo)
      : undefined;

    const loadDocumentPlan = accessPlan.loadDocuments[0];
    const clearGraph = accessPlan.clearGraphs[0];
    const graphCopyPlan = accessPlan.graphCopies[0];
    let nativeOptions: SparqlVoidOptions | undefined;
    if (loadDocumentPlan) {
      try {
        nativeOptions = { loadDocument: await this.readLoadDocument(loadDocumentPlan, queryRequest.baseUrl, readAccessScope) };
      } catch (error) {
        if (!loadDocumentPlan.silent) {
          throw error;
        }
      }
    }
    const rewritten = loadDocumentPlan
      ? this.updateAuthority && nativeOptions?.loadDocument
        ? this.rewriteLoadedDocumentUpdate(loadDocumentPlan, nativeOptions.loadDocument)
        : this.rewriteLoadUpdate(loadDocumentPlan)
      : clearGraph
        ? this.rewriteClearGraphUpdate(clearGraph)
        : graphCopyPlan
          ? this.rewriteGraphCopyUpdate(graphCopyPlan)
      : this.rewriteDefaultGraphUpdates(parsed, queryRequest.baseUrl);
    this.logger.verbose(`[SubgraphSPARQL] Rewritten Query: ${rewritten}`);

    const skippedSilentAuthorityLoad = Boolean(
      this.updateAuthority && loadDocumentPlan?.silent && !nativeOptions?.loadDocument,
    );
    // A LOAD that resolved to an empty document rewrites to `INSERT DATA { GRAPH <g> { } }`,
    // which cannot create or change anything, so it must not notify either.
    const emptyAuthorityLoad = Boolean(
      this.updateAuthority && loadDocumentPlan && nativeOptions?.loadDocument?.body.trim().length === 0,
    );
    const emitActivities = Boolean(this.emitter) && !emptyAuthorityLoad;
    // Existence has to be captured before the write because the activity term depends on it
    // (`Create` for a document the update brings into existence, `Update` otherwise).
    const write = async (): Promise<void> => {
      const pendingActivities = emitActivities ? await this.resolvePendingActivities(accessPlan) : [];
      if (!skippedSilentAuthorityLoad) {
        if (this.updateAuthority) {
          await this.updateAuthority.executeSparqlUpdate(
            rewritten,
            queryRequest.baseUrl,
            readAccessScope,
          );
        } else {
          await this.engine.queryVoid(rewritten, queryRequest.baseUrl, readAccessScope, nativeOptions);
        }
        // Only a successful write notifies; a throwing write skips this line entirely.
        this.emitActivities(pendingActivities);
      }
    };
    // ACL authorization can read through ResourceStore; complete it before taking non-reentrant write locks.
    if (this.mutationStore) await this.mutationStore.withMutationLocks({ path: queryRequest.baseUrl }, write);
    else await write();
    await this.refreshUsage(queryRequest.baseUrl);

    response.statusCode = 204;
    response.setHeader('Cache-Control', 'no-store');
    response.end();
  }

  /**
   * Turns the write targets of an update access plan into the activities that should be emitted.
   *
   * Only documents actually written by the update (the plan's `writeTargets`) are considered:
   * one activity per document, never per quad and never for an untouched resource.
   */
  private async resolvePendingActivities(plan: UpdateAccessPlan): Promise<PendingActivity[]> {
    const pending: PendingActivity[] = [];
    for (const [ graph, effect ] of plan.targetEffects) {
      const documentUrl = this.resourceUrlForGraphValue(graph);
      const existedBefore = await this.documentExistedBefore(documentUrl);
      const activity = this.resolveActivity(effect, existedBefore);
      if (activity) {
        pending.push({ identifier: { path: documentUrl }, activity });
      }
    }
    return pending;
  }

  /**
   * Maps the SPARQL update operation applied to one document to the ActivityStream term the
   * CSS notification generators understand (`MonitoringStore` only forwards `as:Add|Create|Delete|Remove|Update`).
   *
   * Mapping (the closest faithful term for each operation):
   * - `CREATE [SILENT] GRAPH`                      -> `as:Create` when the document did not exist yet;
   *                                                   a `CREATE` on an existing graph is a silent no-op -> nothing.
   * - `INSERT DATA` / `INSERT … WHERE` / `LOAD` /
   *   `ADD` / `COPY` target                        -> `as:Create` when the document did not exist yet, else `as:Update`
   *                                                   (same `exists ? Update : Create` rule CSS uses for PUT).
   * - `DELETE DATA` / `DELETE WHERE` /
   *   `INSERT … DELETE … WHERE`                    -> `as:Update` (partial removal; the document itself survives).
   * - `CLEAR GRAPH` / `DROP GRAPH` / `MOVE` source -> `as:Update`: every triple is gone, but
   `MixDataAccessor.executeSparqlUpdate` rewrites the graph into an *empty* document instead of
   removing the resource, so a re-read returns 200-empty rather than 404. That observable result
   equals a `DELETE DATA` which removes every triple, which maps to `Update`. `as:Delete` is
   therefore deliberately unused: it becomes correct only once an accessor actually removes the
   document (a re-read would then be 404).
   * - delete-only update on a missing document     -> nothing (SPARQL no-op).
   * - `as:Add` / `as:Remove` are deliberately not used: those describe container membership changes
   *   (`DataAccessorBasedStore.addContainerActivity`), and the sidecar writes document graphs only.
   */
  private resolveActivity(effect: UpdateTargetEffect, existedBefore: boolean | undefined): UpdateActivity | undefined {
    if (effect.createdGraph) {
      return existedBefore === true ? undefined : AS.terms.Create;
    }
    if (!effect.addedData && existedBefore === false) {
      // DELETE/CLEAR/DROP against a document that does not exist changes nothing.
      return undefined;
    }
    if (!effect.addedData && effect.removedAllData) {
      // CLEAR/DROP/MOVE-source: the document survives as an empty document, so this is an update.
      return AS.terms.Update;
    }
    if (existedBefore === false) {
      return AS.terms.Create;
    }
    return AS.terms.Update;
  }

  /**
   * Checks whether the document already exists before the update is applied.
   *
   * Uses the same accessor that performs the write, so the answer describes the storage the
   * activity is about. Returns `undefined` when the answer cannot be determined; callers then
   * fall back to the conservative `Update`/`Delete` terms instead of `Create`.
   */
  private async documentExistedBefore(documentUrl: string): Promise<boolean | undefined> {
    if (!this.updateAuthority) {
      return undefined;
    }
    try {
      await this.updateAuthority.getMetadata({ path: documentUrl });
      return true;
    } catch (error) {
      if (NotFoundHttpError.isInstance(error)) {
        return false;
      }
      this.logger.debug(`Could not determine pre-update existence of ${documentUrl}: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  /**
   * Emits the resolved activities on the injected {@link ActivityEmitter}.
   *
   * Mirrors `MonitoringStore.emitChanged`
   * (node_modules/@solid/community-server/dist/storage/MonitoringStore.js:36-45): for every changed resource
   * one `changed` event plus the ActivityStream-typed event, with the same metadata shape
   * `DataAccessorBasedStore.addActivityMetadata` produces (an `urn:npm:solid:community-server:activity:` quad).
   * `ListeningActivityHandler` (dist/server/notifications/ListeningActivityHandler.js:25) subscribes to `changed`
   * and derives the notification state by re-reading the store, so no ETag has to be carried here.
   */
  private emitActivities(activities: PendingActivity[]): void {
    if (!this.emitter || activities.length === 0) {
      return;
    }
    for (const { identifier, activity } of activities) {
      const metadata = new RepresentationMetadata(identifier, { [SOLID_AS.activity]: activity });
      this.emitter.emit('changed', identifier, activity, metadata);
      this.emitter.emit(activity.value, identifier, metadata);
      this.logger.debug(`[SubgraphSPARQL] Emitted ${activity.value} activity for ${identifier.path}`);
    }
  }

  private async sendPayload(response: HttpResponse, payload: string | Buffer, contentType: string, context: UsageContext | undefined, statusCode = 200): Promise<void> {
    const buffer = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
    const limit = context ? await this.resolveBandwidthLimit(context) : undefined;
    return this.streamWithLimit(response, buffer, limit, statusCode, contentType);
  }

  private async streamWithLimit(response: HttpResponse, buffer: Buffer, limit?: number | null, statusCode = 200, contentType?: string): Promise<void> {
    if (contentType) {
      response.setHeader('content-type', contentType);
    }
    response.statusCode = statusCode;
    const normalized = this.normalizeLimit(limit);
    let stream: NodeJS.ReadableStream = Readable.from([ buffer ]);
    if (normalized) {
      stream = stream.pipe(createBandwidthThrottleTransform({ bytesPerSecond: normalized }));
    }
    await pipeline(stream, response);
  }

  private async resolveUsageContext(basePath: string): Promise<UsageContext | undefined> {
    // Try to look up pod from identity database first
    if (this.podLookup) {
      try {
        const pod = await this.podLookup.findByResourceIdentifier(basePath);
        if (pod) {
          return {
            accountId: pod.accountId,
            podId: pod.podId,
          };
        }
      } catch (error) {
        // Gracefully handle missing tables (e.g., dev mode without identity DB setup)
        this.logger.debug(`Failed to lookup pod for usage context: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // Fallback: infer pod from URL path (e.g., /alice/foo → podId=alice)
    // This allows usage tracking without identity database
    if (this.usageRepo) {
      const podId = this.inferPodIdFromPath(basePath);
      if (podId) {
        return {
          accountId: podId, // Use podId as accountId when identity DB not available
          podId,
        };
      }
    }

    return undefined;
  }

  private inferPodIdFromPath(basePath: string): string | undefined {
    // Extract first path segment as pod ID: /alice/foo/bar → alice
    const match = basePath.match(/^\/([^/]+)\//);
    if (match && match[1] && !match[1].startsWith('.')) {
      return match[1];
    }
    return undefined;
  }

  private async resolveBandwidthLimit(context: UsageContext): Promise<number | null | undefined> {
    if (!this.usageRepo) {
      return this.defaultBandwidthLimit;
    }
    const podRecord = await this.usageRepo.getPodUsage(context.podId);
    if (podRecord && podRecord.bandwidthLimitBps !== undefined) {
      return this.normalizeLimit(podRecord.bandwidthLimitBps);
    }
    const accountRecord = await this.usageRepo.getAccountUsage(context.accountId);
    if (accountRecord && accountRecord.bandwidthLimitBps !== undefined) {
      return this.normalizeLimit(accountRecord.bandwidthLimitBps);
    }
    return this.defaultBandwidthLimit;
  }

  private async recordBandwidth(context: UsageContext | undefined, ingress: number, egress: number): Promise<void> {
    if (!context || !this.usageRepo) {
      return;
    }
    const normalizedIngress = this.normalizeBandwidthDelta(ingress);
    const normalizedEgress = this.normalizeBandwidthDelta(egress);
    if (normalizedIngress === 0 && normalizedEgress === 0) {
      return;
    }
    await this.usageRepo.incrementUsage(context.accountId, context.podId, 0, normalizedIngress, normalizedEgress);
  }

  private normalizeLimit(limit?: number | null): number | null {
    if (limit == null) {
      return null;
    }
    const numeric = Number(limit);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      return null;
    }
    return Math.max(0, Math.trunc(numeric));
  }

  private normalizeBandwidthDelta(value: number): number {
    if (!Number.isFinite(value) || value <= 0) {
      return 0;
    }
    return Math.trunc(value);
  }

  private async resolveReadAccessScope(baseUrl: string, request: HttpRequest): Promise<RdfAccessScope> {
    const memo: AuthorizationMemo = new Map();
    const credentials = await this.authorizeFor(baseUrl, request, [ PERMISSIONS.Read ], memo);
    return this.resolveReadAccessScopeForCredentials(baseUrl, credentials, memo);
  }

  private async resolveReadAccessScopeForCredentials(
    baseUrl: string,
    credentials: Credentials,
    memo?: AuthorizationMemo,
  ): Promise<RdfAccessScope> {
    const listStartedAt = Date.now();
    const graphs = await this.engine.listGraphs(baseUrl);
    const listMs = Date.now() - listStartedAt;
    // Credentials and ACLs are fixed within one request, so several graph IRIs that
    // resolve to the same resource share one decision (metadata graphs use a scheme
    // prefix that resourceUrlForGraphValue strips). Authorize each distinct resource
    // once, then map the decision back to every graph that resolves to it.
    const graphsByResource = new Map<string, string[]>();
    for (const graph of graphs) {
      const resourceUrl = this.resourceUrlForGraphValue(graph);
      if (!resourceUrl.startsWith(baseUrl)) {
        continue;
      }
      const mapped = graphsByResource.get(resourceUrl);
      if (mapped) {
        mapped.push(graph);
      } else {
        graphsByResource.set(resourceUrl, [ graph ]);
      }
    }
    const entries = [ ...graphsByResource.entries() ];
    // These authorizations are independent and latency-bound; run them concurrently (bounded)
    // instead of serially so a room's graph count does not multiply each read's latency.
    const authStartedAt = Date.now();
    const allowed = await mapBounded(entries, GRAPH_AUTHORIZATION_CONCURRENCY, ([ resourceUrl ]) =>
      this.canAuthorizeFor(resourceUrl, credentials, [ PERMISSIONS.Read ], memo));
    // Existing debug logging only: lets an operator attribute a slow read to graph listing vs the
    // authorization phase without any new config or caller parameter.
    this.logger.debug(
      `Subgraph read access scope for ${baseUrl}: graphs=${graphs.size} checked=${entries.length} listMs=${listMs} checkMs=${Date.now() - authStartedAt}`,
    );
    const deniedGraphUrls: string[] = [];
    entries.forEach(([ , resourceGraphs ], index) => {
      if (!allowed[index]) {
        deniedGraphUrls.push(...resourceGraphs);
      }
    });
    deniedGraphUrls.sort();

    return {
      basePath: baseUrl,
      mode: 'read',
      principal: credentials.agent?.webId ?? credentials.client?.clientId ?? 'anonymous',
      ...(deniedGraphUrls.length > 0 ? { deniedGraphUrls } : {}),
      version: deniedGraphUrls.length > 0
        ? `graphs:${graphs.size}:denied:${deniedGraphUrls.join(',')}`
        : `graphs:${graphs.size}:inherited`,
    };
  }

  private trustedReadAccessScope(baseUrl: string): RdfAccessScope {
    return {
      basePath: baseUrl,
      mode: 'read',
      principal: `trusted:${baseUrl}`,
      version: `trusted-owner:${baseUrl}`,
    };
  }

  private async authorizeFor(
    basePath: string,
    request: HttpRequest,
    modes: string[],
    memo?: AuthorizationMemo,
  ): Promise<Credentials> {
    if (modes.length === 0) {
      return this.credentialsExtractor.handleSafe(request);
    }
    const credentials = await this.credentialsExtractor.handleSafe(request);
    await this.authorizeIdentifier(basePath, credentials, modes, memo);
    return credentials;
  }

  private async canAuthorizeFor(
    basePath: string,
    credentials: Credentials,
    modes: string[],
    memo?: AuthorizationMemo,
  ): Promise<boolean> {
    try {
      await this.authorizeIdentifier(basePath, credentials, modes, memo);
      return true;
    } catch (error) {
      this.logger.debug(`ACL/ACR graph denied for ${basePath}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  private async authorizeIdentifier(
    basePath: string,
    credentials: Credentials,
    modes: string[],
    memo?: AuthorizationMemo,
  ): Promise<void> {
    const key = JSON.stringify([ basePath, [ ...new Set(modes) ].sort() ]);
    let pending = memo?.get(key);
    if (!pending) {
      pending = (async() => {
        const identifier = { path: basePath } satisfies ResourceIdentifier;
        const requestedModes = new IdentifierSetMultiMap<string>();
        for (const mode of modes) {
          requestedModes.add(identifier, mode);
        }
        const availablePermissions = await this.permissionReader.handleSafe({ credentials, requestedModes });
        await this.authorizer.handleSafe({ credentials, requestedModes, availablePermissions });
      })();
      memo?.set(key, pending);
    }
    try {
      await pending;
    } catch (error) {
      if (memo?.get(key) === pending) {
        memo.delete(key);
      }
      throw error;
    }
  }

  private inspectUpdateGraphs(update: SparqlUpdate, basePath: string): UpdateAccessPlan {
    const plan: UpdateAccessPlan = {
      hasInsert: false,
      hasDelete: false,
      needsReadScope: false,
      readTargets: new Set(),
      writeTargets: new Map(),
      targetEffects: new Map(),
      loadDocuments: [],
      clearGraphs: [],
      graphCopies: [],
    };
    for (const operation of update.updates ?? []) {
      if (this.isLoadOperation(operation)) {
        if ((update.updates?.length ?? 0) !== 1) {
          throw new BadRequestHttpError('SPARQL LOAD cannot be mixed with other update operations on the /-/sparql endpoint.');
        }
        plan.hasInsert = true;
        plan.needsReadScope = true;
        const sourceUri = this.assertGraphTermInScope(operation.source, basePath);
        if (!sourceUri) {
          throw new BadRequestHttpError('SPARQL LOAD source must be an explicit in-pod IRI.');
        }
        const targetGraph = operation.destination
          ? this.assertGraphTermInScope(operation.destination, basePath)
          : basePath;
        plan.readTargets.add(sourceUri);
        this.addWriteTarget(plan, targetGraph ?? basePath, [ PERMISSIONS.Append ], { addedData: true });
        plan.loadDocuments.push({
          sourceUri,
          targetGraph: targetGraph ?? basePath,
          ...((operation as { silent?: boolean }).silent ? { silent: true } : {}),
        });
        continue;
      }

      if (this.isClearGraphOperation(operation) || this.isDropGraphOperation(operation)) {
        if ((update.updates?.length ?? 0) !== 1) {
          throw new BadRequestHttpError('SPARQL graph deletion operations cannot be mixed with other update operations on the /-/sparql endpoint.');
        }
        plan.hasDelete = true;
        plan.needsReadScope = true;
        const graph = this.assertGraphInScope(operation.graph, basePath) ?? basePath;
        this.addWriteTarget(plan, graph, [ PERMISSIONS.Delete ], { removedAllData: true });
        plan.clearGraphs.push(graph);
        continue;
      }

      if (this.isGraphCopyOperation(operation)) {
        if ((update.updates?.length ?? 0) !== 1) {
          throw new BadRequestHttpError('SPARQL graph copy operations cannot be mixed with other update operations on the /-/sparql endpoint.');
        }
        const sourceGraph = this.assertGraphInScope(operation.source, basePath) ?? basePath;
        const targetGraph = this.assertGraphInScope(operation.destination, basePath) ?? basePath;
        plan.hasInsert = true;
        plan.needsReadScope = true;
        plan.readTargets.add(sourceGraph);
        // A self copy/add/move is reduced by `rewriteGraphCopyUpdate` to `CREATE SILENT GRAPH <targetGraph>`,
        // so such a target is only (possibly) created and never cleared or re-filled.
        const selfCopy = sourceGraph === targetGraph;
        const targetEffect: Partial<UpdateTargetEffect> = selfCopy
          ? { createdGraph: true }
          : { removedAllData: true, addedData: true };
        if (operation.type === 'add') {
          this.addWriteTarget(plan, targetGraph, [ PERMISSIONS.Append ], selfCopy ? targetEffect : { addedData: true });
        } else if (operation.type === 'copy') {
          plan.hasDelete = true;
          this.addWriteTarget(plan, targetGraph, [ PERMISSIONS.Delete, PERMISSIONS.Append ], targetEffect);
        } else {
          plan.hasDelete = true;
          this.addWriteTarget(plan, targetGraph, [ PERMISSIONS.Delete, PERMISSIONS.Append ], targetEffect);
          this.addWriteTarget(plan, sourceGraph, [ PERMISSIONS.Delete ], selfCopy ? {} : { removedAllData: true });
        }
        plan.graphCopies.push({ operation: operation.type, sourceGraph, targetGraph });
        continue;
      }

      if (this.isCreateGraphOperation(operation)) {
        plan.hasInsert = true;
        const graph = this.assertGraphInScope(operation.graph, basePath) ?? basePath;
        this.addWriteTarget(plan, graph, [ PERMISSIONS.Append ], { createdGraph: true });
        continue;
      }

      if (!this.isInsertDeleteOperation(operation)) {
        throw new BadRequestHttpError('SPARQL update management operations are not supported.');
      }

      if (operation.updateType === 'insert' ||
        (operation.updateType === 'insertdelete' && (operation.insert?.length ?? 0) > 0)) {
        plan.hasInsert = true;
      }

      if (operation.updateType === 'delete' || operation.updateType === 'deletewhere' ||
        (operation.updateType === 'insertdelete' && (operation.delete?.length ?? 0) > 0)) {
        plan.hasDelete = true;
      }

      const defaultGraph = operation.graph
        ? this.assertGraphInScope(operation.graph, basePath) ?? basePath
        : basePath;

      if (operation.graph) {
        this.assertGraphInScope(operation.graph, basePath);
      }

      if (operation.updateType === 'insert' || operation.updateType === 'insertdelete') {
        this.inspectQuads(operation.insert ?? [], basePath, defaultGraph, plan, [ PERMISSIONS.Append ], { addedData: true });
      }

      if (operation.updateType === 'delete' || operation.updateType === 'insertdelete' || operation.updateType === 'deletewhere') {
        this.inspectQuads(operation.delete ?? [], basePath, defaultGraph, plan, [ PERMISSIONS.Delete ]);
      }

      if (operation.updateType === 'insertdelete' || operation.updateType === 'deletewhere') {
        plan.needsReadScope = true;
      }

      if (operation.updateType === 'insertdelete') {
        this.inspectPatterns(operation.where ?? [], basePath);
        if (operation.using) {
          for (const iri of operation.using.default ?? []) {
            this.assertGraphTermInScope(iri, basePath);
          }
          for (const iri of operation.using.named ?? []) {
            this.assertGraphTermInScope(iri, basePath);
          }
        }
      }
    }
    return plan;
  }

  private inspectQuads(
    quads: SparqlQuads[],
    basePath: string,
    defaultGraph: string,
    plan: UpdateAccessPlan,
    modes: string[],
    effect: Partial<UpdateTargetEffect> = {},
  ): void {
    for (const quad of quads) {
      if (quad.type === 'graph') {
        const graph = this.assertGraphTermInScope(quad.name, basePath);
        if (graph) {
          this.addWriteTarget(plan, graph, modes, effect);
        }
      } else {
        this.addWriteTarget(plan, defaultGraph, modes, effect);
      }
    }
  }

  private inspectPatterns(patterns: SparqlPattern[], basePath: string): void {
    for (const pattern of patterns) {
      if (pattern.type === 'graph') {
        this.assertGraphTermInScope(pattern.name, basePath);
      }
      const nested = (pattern as any).patterns;
      if (Array.isArray(nested)) {
        this.inspectPatterns(nested as SparqlPattern[], basePath);
      }
    }
  }

  private assertGraphInScope(graph: SparqlGraphOrDefault | SparqlIriTerm, basePath: string): string | undefined {
    if ('default' in graph && graph.default) {
      return undefined;
    }
    if ('name' in graph) {
      const name = graph.name;
      if (name) {
        return this.assertGraphTermInScope(name, basePath);
      }
    } else if ('value' in graph) {
      return this.assertGraphTermInScope(graph, basePath);
    }
    return undefined;
  }

  private assertGraphTermInScope(term: SparqlTerm, basePath: string): string | undefined {
    if (!term) {
      return undefined;
    }
    if (term.termType === 'Variable') {
      throw new BadRequestHttpError('Graph IRIs must be explicit when using the /-/sparql update endpoint.');
    }
    if (term.termType === 'NamedNode') {
      const graphValue = term.value;
      const pathPart = this.resourceUrlForGraphValue(graphValue);
      if (!pathPart.startsWith(basePath)) {
        throw new BadRequestHttpError(`Graph ${term.value} is outside of ${basePath}.`);
      }
      return graphValue;
    }
    if ((term as any).default === true) {
      return undefined;
    }
    throw new BadRequestHttpError('Unsupported graph target in SPARQL update.');
  }

  /**
   * Registers a graph as written by the update and records which kind of change applies to it.
   *
   * Several operations can target the same graph in one request; the flags are accumulated so the graph
   * still yields at most one activity. This is also the only place write targets are created, which keeps
   * notification coverage tied to the same plan that drives authorization.
   */
  private addWriteTarget(
    plan: UpdateAccessPlan,
    graph: string,
    modes: string[],
    effect: Partial<UpdateTargetEffect> = {},
  ): void {
    const existing = plan.writeTargets.get(graph) ?? new Set<string>();
    for (const mode of modes) {
      existing.add(mode);
    }
    plan.writeTargets.set(graph, existing);
    const merged = plan.targetEffects.get(graph) ?? { addedData: false, removedAllData: false, createdGraph: false };
    for (const key of Object.keys(effect) as (keyof UpdateTargetEffect)[]) {
      if (effect[key]) {
        merged[key] = true;
      }
    }
    plan.targetEffects.set(graph, merged);
  }

  private async readLoadDocument(
    plan: LoadDocumentPlan,
    basePath: string,
    accessScope?: RdfAccessScope,
  ): Promise<SparqlLoadDocumentOptions> {
    const quads = await this.engine.constructGraph(plan.sourceUri, basePath, accessScope);
    const lines: string[] = [];
    for await (const quad of quads as AsyncIterable<RdfQuad>) {
      lines.push([
        SubgraphSparqlHttpHandler.termToNQuads(quad.subject),
        SubgraphSparqlHttpHandler.termToNQuads(quad.predicate),
        SubgraphSparqlHttpHandler.termToNQuads(quad.object),
        '.',
      ].join(' '));
    }
    return {
      sourceUri: plan.sourceUri,
      body: lines.length > 0 ? `${lines.join('\n')}\n` : '',
      mediaType: 'application/n-triples',
    };
  }

  private rewriteLoadUpdate(plan: LoadDocumentPlan): string {
    return `LOAD ${plan.silent ? 'SILENT ' : ''}<${plan.sourceUri}> INTO GRAPH <${plan.targetGraph}>`;
  }

  private rewriteLoadedDocumentUpdate(
    plan: LoadDocumentPlan,
    document: SparqlLoadDocumentOptions,
  ): string {
    return `INSERT DATA { GRAPH <${plan.targetGraph}> {\n${document.body}\n} }`;
  }

  private rewriteClearGraphUpdate(graph: string): string {
    return `DELETE WHERE { GRAPH <${graph}> { ?s ?p ?o } }`;
  }

  private rewriteGraphCopyUpdate(plan: GraphCopyPlan): string {
    if (plan.sourceGraph === plan.targetGraph) {
      return `CREATE SILENT GRAPH <${plan.targetGraph}>`;
    }
    const insert = `INSERT { GRAPH <${plan.targetGraph}> { ?s ?p ?o } } WHERE { GRAPH <${plan.sourceGraph}> { ?s ?p ?o } }`;
    if (plan.operation === 'add') {
      return insert;
    }
    const clearTarget = this.rewriteClearGraphUpdate(plan.targetGraph);
    if (plan.operation === 'copy') {
      return `${clearTarget}; ${insert}`;
    }
    return `${clearTarget}; ${insert}; ${this.rewriteClearGraphUpdate(plan.sourceGraph)}`;
  }

  private resourceUrlForGraphValue(graphValue: string): string {
    const prefixMatch = graphValue.match(/^([a-z][a-z0-9-]*):(?!\/\/)/i);
    return prefixMatch ? graphValue.slice(prefixMatch[0].length) : graphValue;
  }

  /**
   * Rewrites INSERT/DELETE/INSERT+DELETE that target the default graph (or BGP without GRAPH)
   * so they write to the resource graph (graphIri).
   */
  private rewriteDefaultGraphUpdates(parsed: SparqlUpdate, graphIri: string): string {
    const graphNode = DataFactory.namedNode(graphIri);

    const rewritePatterns = (patterns?: SparqlQuads[]): SparqlQuads[] | undefined => {
      if (!patterns) return patterns;
      return patterns.map((pattern: any): SparqlQuads => {
        if (pattern.type === 'bgp') {
          return { type: 'graph', name: graphNode, triples: pattern.triples } as unknown as SparqlQuads;
        }
        if (pattern.type === 'graph' && pattern.name?.termType === 'DefaultGraph') {
          return { ...pattern, name: graphNode };
        }
        return pattern;
      });
    };

    parsed.updates = parsed.updates.map((op: any): UpdateOperation => {
      if (op.updateType === 'insert' || op.updateType === 'delete' || op.updateType === 'insertdelete') {
        return {
          ...op,
          insert: rewritePatterns(op.insert),
          delete: rewritePatterns(op.delete),
        };
      }
      if (op.updateType === 'deletewhere') {
        return {
          ...op,
          delete: rewritePatterns(op.delete),
        };
      }
      return op;
    });

    return this.generator.stringify(parsed);
  }

  private async refreshUsage(basePath: string): Promise<void> {
    if (!this.usageRepo || !this.podLookup) {
      return;
    }
    const pod = await this.podLookup.findByResourceIdentifier(basePath);
    if (!pod) {
      this.logger.warn(`Skipping quota update for ${basePath}: unable to resolve owning pod.`);
      return;
    }
    const graphs = await this.engine.listGraphs(basePath);
    let totalBytes = 0;
    for (const graph of graphs) {
      totalBytes += await this.computeGraphSize(graph, basePath);
    }
    await this.usageRepo.setPodStorage(pod.accountId, pod.podId, totalBytes);
  }

  private async computeGraphSize(graph: string, basePath: string): Promise<number> {
    const stream = await this.engine.constructGraph(graph, basePath);
    let bytes = 0;
    try {
      for await (const quad of stream as AsyncIterable<RdfQuad>) {
        bytes += SubgraphSparqlHttpHandler.measureQuad(quad);
      }
    } finally {
      const close = (stream as unknown as { close?: () => void }).close;
      if (typeof close === 'function') {
        close();
      }
    }
    return bytes;
  }

  private writeOptions(response: HttpResponse): void {
    response.statusCode = 204;
    response.setHeader('Allow', ALLOWED_METHODS.join(','));
    response.end();
  }

  private async extractQuery(request: HttpRequest, method: string): Promise<QueryRequest> {
    const url = this.parseUrl(request);
    const path = decodeURIComponent(url.pathname);

    // Sidecar pattern: /alice/-/sparql → basePath = /alice/
    // Or: /alice/photos/-/sparql → basePath = /alice/photos/
    const sidecarIndex = path.indexOf(this.sidecarPath);
    if (sidecarIndex === -1) {
      throw new NotImplementedHttpError('Request is not targeting a subgraph SPARQL endpoint.');
    }

    let basePath = path.slice(0, sidecarIndex);
    const isContainer = this.isContainerSidecarBase(basePath);
    if (isContainer && !basePath.endsWith('/')) {
      basePath = `${basePath}/`;
    }

    let query: string | null = null;
    let ingressBytes = 0;

    if (method === 'GET') {
      query = url.searchParams.get('query');
      if (query) {
        ingressBytes += Buffer.byteLength(query, 'utf8');
      }
    } else {
      const contentTypeHeader = request.headers['content-type'] ?? request.headers['Content-Type'];
      const contentType = Array.isArray(contentTypeHeader) ? contentTypeHeader[0] : contentTypeHeader;
      const normalized = contentType?.split(';')[0].trim().toLowerCase();

      if (normalized === 'application/sparql-query' || normalized === 'application/sparql-update') {
        const body = await this.readBody(request);
        ingressBytes += Buffer.byteLength(body, 'utf8');
        query = body.trim();
      } else if (normalized === 'application/x-www-form-urlencoded') {
        const body = await this.readBody(request);
        ingressBytes += Buffer.byteLength(body, 'utf8');
        const params = new URLSearchParams(body);
        query = params.get('query') ?? params.get('update');
      } else {
        throw new UnsupportedMediaTypeHttpError('Supported content types are application/sparql-query, application/sparql-update, or application/x-www-form-urlencoded.');
      }
    }

    if (!query || query.trim().length === 0) {
      throw new BadRequestHttpError('A SPARQL query must be supplied through the "query" parameter or request body.');
    }

    const origin = `${url.protocol}//${url.host}`;
    const baseUrl = `${origin}${basePath}`;
    return {
      basePath,
      baseUrl,
      ...(isContainer ? {} : { sourceUri: baseUrl }),
      defaultDataset: isContainer ? 'scopedUnion' : 'exactSource',
      query: query.trim(),
      origin,
      method,
      ingressBytes,
    };
  }

  private parseUrl(request: HttpRequest): URL {
    const hostHeader = request.headers.host ?? request.headers.Host ?? 'localhost';
    const protocolHeader = (request.headers['x-forwarded-proto'] ?? request.headers['X-Forwarded-Proto']) as string | undefined;
    const protocol = protocolHeader?.split(',')[0]?.trim() ?? 'http';
    const requestUrl = request.url ?? '/';
    return new URL(requestUrl, `${protocol}://${hostHeader}`);
  }

  private isContainerSidecarBase(basePath: string): boolean {
    const lastSegment = basePath.split('/').filter(Boolean).pop() ?? '';
    if (lastSegment.length === 0) {
      return true;
    }

    const extensionStart = lastSegment.lastIndexOf('.');
    return extensionStart <= 0;
  }

  private async readBody(request: HttpRequest): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
      let data = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => {
        data += chunk;
      });
      request.on('end', () => resolve(data));
      request.on('error', reject);
    });
  }

  private termToJson(term: Term): Record<string, string> {
    switch (term.termType) {
      case 'NamedNode':
        return { type: 'uri', value: term.value };
      case 'BlankNode':
        return { type: 'bnode', value: term.value };
      case 'Literal': {
        const literal = term as Literal;
        if (literal.language) {
          return {
            type: 'literal',
            value: literal.value,
            'xml:lang': literal.language,
          };
        }
        const datatype = literal.datatype?.value;
        if (datatype && datatype !== SubgraphSparqlHttpHandler.XSD_STRING) {
          return {
            type: 'literal',
            value: literal.value,
            datatype,
          };
        }
        return { type: 'literal', value: literal.value };
      }
      default:
        return { type: 'literal', value: term.value };
    }
  }

  private static measureQuad(quad: RdfQuad): number {
    const subject = SubgraphSparqlHttpHandler.termToNQuads(quad.subject);
    const predicate = SubgraphSparqlHttpHandler.termToNQuads(quad.predicate);
    const object = SubgraphSparqlHttpHandler.termToNQuads(quad.object);
    const graph = quad.graph.termType === 'DefaultGraph' ? '' : ` ${SubgraphSparqlHttpHandler.termToNQuads(quad.graph)}`;
    const serialized = `${subject} ${predicate} ${object}${graph} .\n`;
    return Buffer.byteLength(serialized, 'utf8');
  }

  private static termToNQuads(term: Term): string {
    switch (term.termType) {
      case 'NamedNode':
        return `<${term.value}>`;
      case 'BlankNode':
        return `_:${term.value}`;
      case 'Literal':
        return SubgraphSparqlHttpHandler.literalToNQuads(term as Literal);
      case 'DefaultGraph':
        return '';
      default:
        return `<${term.value}>`;
    }
  }

  private static literalToNQuads(literal: Literal): string {
    const escaped = SubgraphSparqlHttpHandler.escapeLiteral(literal.value);
    if (literal.language) {
      return `"${escaped}"@${literal.language}`;
    }
    const datatype = literal.datatype?.value;
    if (datatype && datatype !== SubgraphSparqlHttpHandler.XSD_STRING) {
      return `"${escaped}"^^<${datatype}>`;
    }
    return `"${escaped}"`;
  }

  private static escapeLiteral(value: string): string {
    return value
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t')
      .replace(/\f/g, '\\f')
      .replace(/\u0008/g, '\\b');
  }

  private isInsertDeleteOperation(operation: SparqlUpdate['updates'][number]): operation is SparqlInsertDeleteOperation {
    return typeof (operation as SparqlInsertDeleteOperation).updateType === 'string';
  }

  private isLoadOperation(
    operation: SparqlUpdate['updates'][number],
  ): operation is SparqlUpdate['updates'][number] & { type: 'load'; source: SparqlIriTerm; destination?: SparqlIriTerm } {
    const candidate = operation as { type?: string; source?: SparqlTerm; destination?: SparqlTerm };
    return candidate.type === 'load' &&
      candidate.source?.termType === 'NamedNode' &&
      (!candidate.destination || candidate.destination.termType === 'NamedNode');
  }

  private isClearGraphOperation(operation: SparqlUpdate['updates'][number]): operation is SparqlUpdate['updates'][number] & { type: 'clear'; graph: SparqlGraphOrDefault | SparqlIriTerm } {
    return (operation as { type?: string }).type === 'clear' && 'graph' in operation;
  }

  private isDropGraphOperation(operation: SparqlUpdate['updates'][number]): operation is SparqlUpdate['updates'][number] & { type: 'drop'; graph: SparqlGraphOrDefault | SparqlIriTerm } {
    return (operation as { type?: string }).type === 'drop' && 'graph' in operation;
  }

  private isGraphCopyOperation(operation: SparqlUpdate['updates'][number]): operation is SparqlUpdate['updates'][number] & { type: 'add' | 'copy' | 'move'; source: SparqlGraphOrDefault | SparqlIriTerm; destination: SparqlGraphOrDefault | SparqlIriTerm } {
    const candidate = operation as { type?: string };
    return (candidate.type === 'add' || candidate.type === 'copy' || candidate.type === 'move') &&
      'source' in operation && 'destination' in operation;
  }

  private isCreateGraphOperation(operation: SparqlUpdate['updates'][number]): operation is SparqlUpdate['updates'][number] & { type: 'create'; graph: SparqlGraphOrDefault | SparqlIriTerm } {
    return (operation as { type?: string }).type === 'create' && 'graph' in operation;
  }

  private getRequestId(request: HttpRequest): string {
    const header = (request.headers['x-request-id'] ?? request.headers['X-Request-Id']) as string | undefined;
    return header?.toString() ?? 'no-request-id';
  }

  private isSqliteUrl(url: string): boolean {
    const lower = url.toLowerCase();
    return lower.startsWith('sqlite:') || lower.endsWith('.sqlite') || lower.endsWith('.db');
  }
}

function trustedCollectionTarget(ownerWebId: string, endpointUrl: string, suffix: string, allowQuery: boolean): TrustedModelCollectionTarget | undefined {
  let owner: URL;
  let endpoint: URL;
  try {
    owner = new URL(ownerWebId);
    endpoint = new URL(endpointUrl);
  } catch {
    return undefined;
  }
  if (owner.protocol !== 'http:' && owner.protocol !== 'https:') {
    return undefined;
  }
  if (owner.hash !== '#me' || !owner.pathname.endsWith('/profile/card')) {
    return undefined;
  }
  const podPath = owner.pathname.slice(0, -'profile/card'.length);
  if (!podPath || !podPath.endsWith('/')) {
    return undefined;
  }
  const podRoot = new URL(podPath, owner.origin);
  if (endpoint.origin !== podRoot.origin || endpoint.username || endpoint.password || endpoint.hash) {
    return undefined;
  }
  if (endpoint.pathname !== `${podRoot.pathname}${suffix.slice(1)}`) {
    return undefined;
  }
  const keys = Array.from(endpoint.searchParams.keys());
  if (!allowQuery && keys.length > 0) {
    return undefined;
  }
  if (allowQuery && keys.length > 0 && (keys.length !== 1 || keys[0] !== 'query' || !endpoint.searchParams.get('query')?.trim())) {
    return undefined;
  }
  const basePath = endpoint.pathname.slice(0, -'/-/sparql'.length);
  const normalizedBasePath = basePath.endsWith('/') ? basePath : `${basePath}/`;
  return {
    basePath: normalizedBasePath,
    baseUrl: `${endpoint.origin}${normalizedBasePath}`,
    defaultDataset: 'scopedUnion',
    origin: endpoint.origin,
    query: endpoint.searchParams.get('query')?.trim() ?? '',
  };
}
