import type { LocalPhysicalOperationService } from '../storage/LocalPhysicalOperationService';
import { Readable } from 'node:stream';
import { getLoggerFor } from 'global-logger-factory';
import { pipeline } from 'node:stream/promises';
import { HttpHandler } from '@solid/community-server';
import type { HttpHandlerInput, HttpRequest, HttpResponse } from '@solid/community-server';
import {
  AS,
  ConflictHttpError,
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
  AuxiliaryIdentifierStrategy,
  Credentials,
  CredentialsExtractor,
  ExpiringReadWriteLocker,
  PermissionReader,
  Authorizer,
  ResourceIdentifier,
  IdentifierStrategy,
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
import type { SparqlCorrection } from '../storage/rdf/RdfSparqlBoundary';
import type { RdfAccessScope } from '../storage/rdf/RdfAccessScope';
import { getIdentityDatabase } from '../identity/drizzle/db';
import { PodLookupRepository } from '../identity/drizzle/PodLookupRepository';
import { UsageRepository } from '../storage/quota/UsageRepository';
import { MixDataAccessor } from '../storage/accessors/MixDataAccessor';
import { metadataRequestContext, type MetadataRequestState } from '../storage/MetadataRequestContext';
import {
  authorityDependenciesFresh,
  collectAuthorityDependencies,
  newAuthoritySnapshotState,
  settleAuthorityReads,
  AuthorityDependencyRetryError,
  type AuthoritySnapshotState,
} from '../storage/AuthoritySnapshotContext';
import { HierarchicalReadWriteLocker } from '../storage/HierarchicalReadWriteLocker';
import { GuardedPolicyClosure } from '../storage/GuardedPolicyClosure';
import { LockingResourceStore } from '../storage/LockingResourceStore';
import { GUARDED_SPARQL_MEDIA_TYPE, parseGuardedPolicyUpdate, sameGuardedPolicySnapshot, guardedPolicyIri, type GuardedPolicySnapshot } from '../storage/rdf/GuardedPolicySnapshot';
import { AUTHORIZATION_OBSERVATION_MEDIA_TYPE, AUTHORIZATION_PROFILE_DECLARATION_MEDIA_TYPE, AUTHORIZATION_PROFILE_NEGOTIATION_MEDIA_TYPE } from '../storage/rdf/AuthorizationObservation';
import { AgentReadObservation } from '../authorization/AgentReadObservation';
import { createBandwidthThrottleTransform } from '../util/stream/BandwidthThrottleTransform';

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
  policyGuard?: GuardedPolicySnapshot;
}

interface SubgraphSparqlHttpHandlerOptions {
  /** @deprecated Use sidecarPath instead */
  resourceSuffix?: string;
  /** @deprecated Use sidecarPath instead */
  containerSuffix?: string;
  /** Sidecar API path segment, default: '/-/sparql' */
  sidecarPath?: string;
  guardedPolicyProfile?: string;
  identityDbUrl?: string;
  usageDbUrl?: string;
  defaultAccountBandwidthLimitBps?: number | null;
}

type UsageContext = {
  accountId: string;
  podId: string;
};

/**
 * The authority resources a scoped write depended on changed between authorization and commit, so
 * the authorization no longer describes the committed state. The update is retried with fresh caches
 * and never committed on a stale attempt.
 */
class StaleSparqlAuthorizationError extends Error {}

interface AuthorizationAttempt {
  snapshot: AuthoritySnapshotState;
  metadata: MetadataRequestState;
}

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
  /** Every fixed named graph referenced in WHERE (including nested EXISTS/NOT EXISTS). */
  whereGraphs: Set<string>;
  /** A variable GRAPH exists in WHERE (the strict full-inventory branch). */
  hasVariableGraph: boolean;
  hasConditionalUpdate: boolean;
  /** An unsupported conditional form (default graph read, SERVICE, subquery, dataset) is present. */
  unsupportedConditionalForm?: string;
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
  private readonly locks?: ExpiringReadWriteLocker;
  /**
   * The CSS auxiliary identifier strategy (`urn:solid-server:default:AuthIdentifierStrategy`, a
   * `SuffixAuxiliaryIdentifierStrategy` selected by the ACL/ACP imports) used to recognise a
   * `.acl`/`.acr` write graph. Optional so allow-all composition omits it instead of dangling.
   */
  private readonly authStrategy?: AuxiliaryIdentifierStrategy;
  private readonly generator = new Generator();
  private readonly guardedPolicyProfile?: string;
  private readonly authorityStore?: LockingResourceStore;
  private readonly identifierStrategy?: IdentifierStrategy;
  private readonly auxiliaryStrategy?: AuxiliaryIdentifierStrategy;
  /** Bounded A1 capability; absent in ACL/allow-all assemblies, where observation is 415. */
  private readonly observation?: AgentReadObservation;

  private static readonly XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';

  public constructor(
    queryEngine: SubgraphQueryEngine,
    credentialsExtractor: CredentialsExtractor,
    permissionReader: PermissionReader,
    authorizer: Authorizer,
    options: SubgraphSparqlHttpHandlerOptions = {},
    updateAuthority?: MixDataAccessor,
    emitter?: ActivityEmitter,
    locks?: ExpiringReadWriteLocker,
    authStrategy?: AuxiliaryIdentifierStrategy,
    authorityStore?: LockingResourceStore,
    identifierStrategy?: IdentifierStrategy,
    auxiliaryStrategy?: AuxiliaryIdentifierStrategy,
    observation?: AgentReadObservation,
    private readonly operationService?: LocalPhysicalOperationService,
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
    this.authStrategy = authStrategy;
    this.guardedPolicyProfile = options.guardedPolicyProfile;
    this.authorityStore = authorityStore;
    this.identifierStrategy = identifierStrategy;
    this.auxiliaryStrategy = auxiliaryStrategy;
    this.observation = observation;
    // The same hierarchical locker the ordinary ResourceStore_Locking uses. A scope WRITE excludes
    // any descendant LDP daily-document write through the shared ancestor lock, which is what turns
    // the sidecar's read-then-commit into one critical section despite the two touching different
    // URLs. Authorization stays *outside* this lock — re-entering the store for ACL/ACR would
    // deadlock against our own write lock.
    this.locks = locks;

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

  public override handle(input: HttpHandlerInput): Promise<void> {
    const execute = (): Promise<void> => this.handleAdmitted(input);
    return this.operationService ? this.operationService.run(execute) : execute();
  }

  private async handleAdmitted({ request, response }: HttpHandlerInput): Promise<void> {
    const method = (request.method ?? 'GET').toUpperCase();

    if (method === 'OPTIONS') {
      this.writeOptions(response);
      return;
    }

    if (!ALLOWED_METHODS.includes(method)) {
      throw new MethodNotAllowedHttpError(ALLOWED_METHODS);
    }

    try {
      // The closed observation media is recognized BEFORE the ordinary SPARQL content-type rejection
      // and parser. It reuses the ONE canonical sidecar/path seam and never fabricates a dummy query.
      if (this.contentTypeOf(request) === AUTHORIZATION_OBSERVATION_MEDIA_TYPE) {
        await this.handleAuthorizationObservation(request, response);
        return;
      }
      // The closed A2N profile negotiation media is the positive server declaration route. Bare 415
      // on either closed media is never a WAC signal; only this route's closed declaration qualifies.
      if (this.contentTypeOf(request) === AUTHORIZATION_PROFILE_NEGOTIATION_MEDIA_TYPE) {
        await this.handleAuthorizationProfileNegotiation(request, response);
        return;
      }
      const queryRequest = await this.extractQuery(request, method);
      const context = await this.resolveUsageContext(queryRequest.basePath);
      await this.recordBandwidth(context, queryRequest.ingressBytes, 0);
      const parser = new Parser({ baseIRI: queryRequest.baseUrl });
      const parsed = parser.parse(queryRequest.query);

      if (queryRequest.policyGuard && parsed.type !== 'update') throw new UnsupportedMediaTypeHttpError('Guarded media requires a conditional update');
      if (parsed.type === 'update') {
        await this.executeUpdate(queryRequest, parsed, request, response, context);
        return;
      }

      const queryType = parsed.queryType ?? 'SELECT';

      switch (queryType) {
        case 'SELECT':
          await this.executeSelect(request, queryRequest, response, context);
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

    let pendingActivities: PendingActivity[] = [];
    let skippedSilentAuthorityLoad = false;
    // Bounded PRE-mutation attempts. Authorization reads local ACL/ACR resources into an
    // authority-dependency snapshot; if one of those resources is mutated before the commit, the
    // attempt is stale, releases everything and is redone with fresh caches. A committed write is
    // never retried (the freshness check runs before any mutation and the write is the last step).
    const maxAttempts = 3;
    const additionalDependencies = new Set<string>();
    for (let attempt = 0; ; attempt += 1) {
      try {
        // Re-parse the original query on every attempt so an earlier attempt's AST mutation (the
        // finite VALUES injection) can never leak into a retry, and decision modes are rebuilt.
        const attemptParsed = attempt === 0
          ? parsed
          : new Parser({ baseIRI: queryRequest.baseUrl }).parse(queryRequest.query) as SparqlUpdate;
        // A fresh authorization-decision cache per attempt: a decision (including a cached denial or
        // a cached 404) must not survive into a retry after a local authority change.
        (request as HttpRequest & { __xpodSparqlAuthz?: Map<string, { error?: unknown }> }).__xpodSparqlAuthz = new Map();
        const result = await metadataRequestContext.run(
          { metadataCache: new Map() },
          () => this.authorizeAndCommitUpdate(queryRequest, attemptParsed, request, trusted, additionalDependencies),
        );
        pendingActivities = result.pendingActivities;
        skippedSilentAuthorityLoad = result.skippedSilentAuthorityLoad;
        break;
      } catch (error) {
        if (error instanceof AuthorityDependencyRetryError) {
          for (const uri of error.lockUris) additionalDependencies.add(uri);
        }
        const stale = error instanceof StaleSparqlAuthorizationError || error instanceof AuthorityDependencyRetryError;
        if (stale && attempt < maxAttempts - 1) {
          this.logger.debug(`[SubgraphSPARQL] Local authority changed mid-window; retrying (${attempt + 1}/${maxAttempts})`);
          continue;
        }
        if (stale) {
          throw new BadRequestHttpError('Local authorization changed during the request; retry the update');
        }
        throw error;
      }
    }
    if (!skippedSilentAuthorityLoad) {
      // Only a successful write notifies; a throwing write skips this line entirely. Notifications
      // are emitted after the lock is released: a listener reads back through the outer store and
      // would otherwise wait on the very lock this request still holds.
      this.emitActivities(pendingActivities);
    }
    await this.refreshUsage(queryRequest.baseUrl);

    response.statusCode = 204;
    response.setHeader('Cache-Control', 'no-store');
    response.end();
  }

  /**
   * One authorization attempt.
   *
   * Discover policy dependencies first, then repeat all strict decisions under their shared plan.
   * The permission store can reuse only proven held authority locks, avoiding nested acquisition.
   */
  private async authorizeAndCommitUpdate(
    queryRequest: QueryRequest,
    parsed: SparqlUpdate,
    request: HttpRequest,
    trusted: boolean,
    additionalDependencies: ReadonlySet<string>,
  ): Promise<{ pendingActivities: PendingActivity[]; skippedSilentAuthorityLoad: boolean }> {
    // Authorization reads local ACL/ACR resources; collect the exact authority dependencies and
    // their mutation snapshots so the commit can detect a change before mutating.
    //
    // Two independent concerns are separated:
    // - `collectPermissionDependencies`: conditional INSERT/DELETE WHERE, variable-GRAPH guards,
    //   and conditional authorization-resource writes need discovery and locked current decisions.
    // - `requireFullInventoryRead`: only the variable-GRAPH guard needs the unfiltered whole-directory
    //   candidate inventory. Ordinary INSERT/DELETE keeps CSS-compatible visible-dataset semantics.
    const guard = queryRequest.policyGuard;
    let closure: GuardedPolicyClosure | undefined;
    let nativeBase = queryRequest.baseUrl;
    if (guard) {
      // The envelope profile must equal the deployed authMode-derived profile; a guard cannot
      // choose a different engine than the actual configuration.
      if (trusted || this.guardedPolicyProfile !== guard.profile || (guard.profile !== 'wac-ground-v1' && guard.profile !== 'acp-ground-v1')
        || !this.podLookup || !this.updateAuthority
        || !(this.locks instanceof HierarchicalReadWriteLocker) || !this.authorityStore
        || !this.authorityStore.usesAuthorityLocker(this.locks) || !this.identifierStrategy || !this.authStrategy || !this.auxiliaryStrategy) {
        throw new UnsupportedMediaTypeHttpError('Guarded policy profile is unavailable');
      }
      if (guard.scope !== queryRequest.baseUrl) throw new ConflictHttpError('Guarded scope does not match the sidecar');
      const pod = await this.podLookup.findByResourceIdentifier(queryRequest.baseUrl);
      const roots = [pod?.baseUrl, pod?.storageUrl].filter((root): root is string => Boolean(root && queryRequest.baseUrl.startsWith(root)))
        .sort((a, b) => b.length - a.length);
      if (!roots.length || !roots[0].endsWith('/')) throw new UnsupportedMediaTypeHttpError('Guarded policy scope has no registered Pod');
      nativeBase = roots[0];
      closure = new GuardedPolicyClosure({ accessor: this.updateAuthority, store: this.authorityStore, locks: this.locks,
        identifierStrategy: this.identifierStrategy, authStrategy: this.authStrategy, auxiliaryStrategy: this.auxiliaryStrategy, podLookup: this.podLookup,
        profile: guard.profile });
    }
    const plan = this.inspectUpdateGraphs(parsed, nativeBase);
    if (guard) {
      const operation = parsed.updates[0];
      if (parsed.updates.length !== 1 || !operation || !('updateType' in operation) || operation.updateType !== 'insertdelete'
        || !plan.hasConditionalUpdate || plan.hasVariableGraph || plan.unsupportedConditionalForm
        || plan.writeTargets.size !== 1 || !plan.whereGraphs.size
        || [...operation.insert ?? [], ...operation.delete ?? []].some(quad => quad.type !== 'graph')) {
        throw new UnsupportedMediaTypeHttpError('Guarded update requires one fixed graph conditional INSERT/DELETE');
      }
    }
    const hasVariableGraphGuard = plan.hasVariableGraph;
    const aclConditional = this.classifyConditionalAuxiliaryWrite(plan);
    if (aclConditional.requested && !aclConditional.ok) {
      // A conditional authorization-resource write in an unsupported shape must fail closed before
      // any authorization or mutation, rather than being treated as an ordinary write.
      throw new UnsupportedSparqlQueryError(
        `Conditional authorization-resource update is not supported: ${aclConditional.reason}`,
        {
          code: 'rdf.sparql.conditional_acl_unsupported',
          capability: 'sparql.update.conditional_acl',
          hint: 'Use one concrete .acl/.acr write graph with fixed named-graph reads and a prepared native authority.',
        },
      );
    }
    const isAclConditional = aclConditional.ok;
    const collectPermissionDependencies = hasVariableGraphGuard || isAclConditional || plan.hasConditionalUpdate;
    const requireFullInventoryRead = hasVariableGraphGuard;
    if (collectPermissionDependencies && !(this.locks instanceof HierarchicalReadWriteLocker)) {
      throw new UnsupportedSparqlQueryError('Conditional update requires a shared hierarchical authority lock plan', {
        code: 'rdf.sparql.conditional_acl_unsupported', capability: 'sparql.update.current_authority',
        hint: 'Configure the shared HierarchicalReadWriteLocker for the handler and permission resource store.',
      });
    }
    // Every read still drains and acknowledges close before the lock can leave. A deliberate
    // guarded rejection remains a rejection even if cancelling its oversized stream also records
    // a read failure; missing lock dependencies retain priority for bounded re-planning.
    const settleAttempt = async(state: AuthoritySnapshotState, failure?: unknown): Promise<void> => {
      try { await settleAuthorityReads(state); }
      catch (error) {
        if (error instanceof AuthorityDependencyRetryError || !guard || !(failure instanceof HttpError)) throw error;
      }
    };
    const state = newAuthoritySnapshotState();
    let authorizationAttempt: AuthorizationAttempt | undefined = collectPermissionDependencies
      ? { snapshot: state, metadata: { metadataCache: new Map() } }
      : undefined;
    const authorizeAttempt = async(): Promise<{
      accessPlan: UpdateAccessPlan;
      readAccessScope: RdfAccessScope | undefined;
      inventory: string[];
    }> => {
      const modes: string[] = [];
      if (plan.needsReadScope) {
        modes.push(PERMISSIONS.Read);
      }
      if (plan.hasInsert) {
        modes.push(PERMISSIONS.Append);
      }
      if (plan.hasDelete) {
        modes.push(PERMISSIONS.Delete);
      }
      const credentials = trusted ? undefined : await this.authorizeFor(queryRequest.baseUrl, request, modes, authorizationAttempt);

      if (!trusted && credentials) {
        for (const source of plan.readTargets) {
          if (source === queryRequest.baseUrl) {
            continue;
          }
          await this.authorizeIdentifier(source, credentials, [ PERMISSIONS.Read ], request, authorizationAttempt);
        }

        for (const [ graph, graphModes ] of plan.writeTargets) {
          const resourceUrl = this.resourceUrlForGraphValue(graph);
          if (resourceUrl === queryRequest.baseUrl) {
            continue;
          }
          await this.authorizeIdentifier(resourceUrl, credentials, [...graphModes], request, authorizationAttempt);
        }

        // The narrow conditional ACL branch read-authorizes every explicit fixed guard graph
        // (including nested EXISTS/NOT EXISTS) — never the whole directory.
        if (isAclConditional || guard) {
          for (const graph of plan.whereGraphs) {
            const resourceUrl = this.resourceUrlForGraphValue(graph);
            if (resourceUrl === queryRequest.baseUrl) {
              continue;
            }
            await this.authorizeIdentifier(resourceUrl, credentials, [ PERMISSIONS.Read ], request, authorizationAttempt);
          }
        }
      }

      const scope = plan.needsReadScope
        ? trusted
          ? this.trustedReadAccessScope(queryRequest.baseUrl)
          : isAclConditional || guard
            // The narrow conditional ACL branch uses the finite explicit read graphs plus the ACL
            // write graph — never the whole-directory enumeration.
            ? this.fixedReadAccessScope(nativeBase, credentials!, aclConditional.writeGraph ?? [...plan.writeTargets.keys()][0], plan)
            : await this.resolveReadAccessScopeForCredentials(queryRequest.baseUrl, credentials!, request, authorizationAttempt)
        : undefined;

      // Unfiltered current candidate inventory. The strict uniqueness guard must fail closed if any
      // candidate graph cannot be read, so every candidate is authorized for READ here. Only the
      // strict variable-GRAPH branch needs this.
      const currentInventory = requireFullInventoryRead
        ? [ ...new Set(await this.engine.listGraphs(queryRequest.baseUrl)) ]
        : [];
      if (requireFullInventoryRead && !trusted && credentials) {
        for (const graph of currentInventory) {
          const resourceUrl = this.resourceUrlForGraphValue(graph);
          if (resourceUrl === queryRequest.baseUrl) {
            continue;
          }
          await this.authorizeIdentifier(resourceUrl, credentials, [ PERMISSIONS.Read ], request, authorizationAttempt);
        }
      }

      if (closure && authorizationAttempt) {
        const actual = await metadataRequestContext.run(authorizationAttempt.metadata, () =>
          collectAuthorityDependencies(authorizationAttempt!.snapshot, () => closure!.read(queryRequest.baseUrl)));
        if (!sameGuardedPolicySnapshot(guard!, actual)) throw new ConflictHttpError('Guarded policy closure changed');
        const graphs = new Set([...actual.resources.map(row => row.iri), ...actual.policies.map(row => row.iri)]);
        for (const graph of [...plan.whereGraphs, ...plan.writeTargets.keys()]) {
          try { guardedPolicyIri(graph); }
          catch { throw new UnsupportedMediaTypeHttpError('Guarded graph is not a canonical document IRI'); }
          if (!graphs.has(graph)) throw new UnsupportedMediaTypeHttpError('Guarded graph is outside the proved policy closure');
        }
      }
      return { accessPlan: plan, readAccessScope: scope, inventory: currentInventory };
    };
    // Only permission calculation collects authority dependencies. Inventory and native work use
    // the ordinary attempt context and cannot populate the separate permission metadata cache.
    let discovered: Awaited<ReturnType<typeof authorizeAttempt>>;
    let discoveryFailure: unknown;
    try { discovered = await authorizeAttempt(); }
    catch (error) { discoveryFailure = error; throw error; }
    finally { await settleAttempt(state, discoveryFailure); }
    const { accessPlan } = discovered;
    let { readAccessScope, inventory } = discovered;

    const loadDocumentPlan = accessPlan.loadDocuments[0];
    const clearGraph = accessPlan.clearGraphs[0];
    const graphCopyPlan = accessPlan.graphCopies[0];
    let skippedSilentAuthorityLoad = false;
    let emitActivities = false;
    // Existence has to be captured before the write because the activity term depends on it
    // (`Create` for a document the update brings into existence, `Update` otherwise). Preparation,
    // condition evaluation and the commit all happen inside the scope lock so no descendant LDP
    // writer can slip in between them.
    const pendingActivities: PendingActivity[] = [];
    const commit = async(): Promise<void> => {
      // Any local ACL/ACR the authorization depended on that changed (or is being changed) makes the
      // authorization stale. This runs BEFORE any mutation, so the attempt can be retried safely.
      if (!authorityDependenciesFresh(state)) {
        throw new StaleSparqlAuthorizationError('A local authority resource changed during the authorization window');
      }
      if (collectPermissionDependencies) {
        const locks = this.locks as HierarchicalReadWriteLocker;
        const fresh = newAuthoritySnapshotState(uri => locks.hasHeldReadLock({ path: uri }));
        authorizationAttempt = { snapshot: fresh, metadata: { metadataCache: new Map() } };
        (request as HttpRequest & { __xpodSparqlAuthz?: Map<string, { error?: unknown }> }).__xpodSparqlAuthz = new Map();
        let freshFailure: unknown;
        try {
          const current = await authorizeAttempt();
          if (hasVariableGraphGuard && (current.inventory.length !== inventory.length
            || current.inventory.some(graph => !inventory.includes(graph)))) {
            throw new StaleSparqlAuthorizationError('The candidate graph inventory changed during authorization');
          }
          readAccessScope = current.readAccessScope;
          inventory = current.inventory;
        } catch (error) { freshFailure = error; throw error; }
        finally { await settleAttempt(fresh, freshFailure); }
        if (!authorityDependenciesFresh(fresh)) throw new StaleSparqlAuthorizationError('Current authority changed during permission reads');
      }
      if (guard) {
        const target = this.resourceUrlForGraphValue([...plan.writeTargets.keys()][0]);
        const mapped = this.authorityStore!.getLockIdentifier({ path: target });
        const policyTarget = this.authStrategy!.isAuxiliaryIdentifier({ path: target });
        const mappedPolicy = [...guard.resources, ...guard.ancestors].some(row => row.policyIri === target);
        const normalTarget = guard.resources.some(row => row.iri === target);
        if (!this.locks || !(this.locks instanceof HierarchicalReadWriteLocker) || !this.locks.hasHeldReadLock(mapped)
          || (policyTarget ? !mappedPolicy : !normalTarget)
          || (mapped.path !== queryRequest.baseUrl && !this.identifierStrategy!.contains({ path: queryRequest.baseUrl }, mapped, true))) {
          throw new UnsupportedMediaTypeHttpError('Guarded write target is outside the actual room WRITE domain');
        }
      }
      // Exact set comparison, not a count: a same-count swap of candidate graphs is still a change.
      // An unreadable candidate was already rejected during authorization (fail closed). Only the
      // strict variable-GRAPH guard maintains an authorized inventory to compare against.
      if (hasVariableGraphGuard) {
        const currentInventory = [ ...new Set(await this.engine.listGraphs(queryRequest.baseUrl)) ];
        if (currentInventory.length !== inventory.length
          || currentInventory.some(graph => !inventory.includes(graph))) {
          throw new StaleSparqlAuthorizationError('The candidate graph inventory changed during the authorization window');
        }
      }
      // The finite graph inventory for a variable-GRAPH existence guard is read here, under the lock,
      // so the condition sees the current committed state. The strict branch binds the exact
      // authorized inventory; an empty inventory injects an empty VALUES that the embedded compiler
      // rejects, rather than dropping the identity constraint.
      await this.injectExistenceGraphInventory(
        parsed,
        queryRequest.baseUrl,
        readAccessScope,
        hasVariableGraphGuard ? inventory : undefined,
      );

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
        : this.rewriteDefaultGraphUpdates(parsed, nativeBase);
      this.logger.verbose(`[SubgraphSPARQL] Rewritten Query: ${rewritten}`);

      skippedSilentAuthorityLoad = Boolean(
        this.updateAuthority && loadDocumentPlan?.silent && !nativeOptions?.loadDocument,
      );
      // A LOAD that resolved to an empty document rewrites to `INSERT DATA { GRAPH <g> { } }`,
      // which cannot create or change anything, so it must not notify either.
      const emptyAuthorityLoad = Boolean(
        this.updateAuthority && loadDocumentPlan && nativeOptions?.loadDocument?.body.trim().length === 0,
      );
      emitActivities = Boolean(this.emitter) && !emptyAuthorityLoad;
      if (emitActivities) {
        pendingActivities.push(...await this.resolvePendingActivities(accessPlan));
      }
      if (!skippedSilentAuthorityLoad) {
        if (this.updateAuthority) {
          await this.updateAuthority.executeSparqlUpdate(
            rewritten,
            nativeBase,
            readAccessScope,
          );
        } else {
          await this.engine.queryVoid(rewritten, queryRequest.baseUrl, readAccessScope, nativeOptions);
        }
      }
    };
    // Acquire the scope WRITE plus every authority resource the authorization depended on, in one
    // deterministic plan, so a concurrent ACL/ACR writer cannot slip between the check and the commit.
    const lockDependencies = [ ...new Set([...additionalDependencies, ...[ ...state.dependencies.values() ].map(dependency => dependency.lockUri)]) ]
      .map(path => ({ path }));
    const locks = this.locks as unknown as {
      withWriteLockAndReadDependencies?: (
        identifier: ResourceIdentifier,
        dependencies: ResourceIdentifier[],
        whileLocked: () => Promise<void>,
      ) => Promise<void>;
      withWriteLock: (identifier: ResourceIdentifier, whileLocked: () => Promise<void>) => Promise<void>;
    } | undefined;
    if (isAclConditional) {
      // The conditional authorization-resource primitive needs both the prepared native authority
      // and the shared hierarchical lock with read dependencies, otherwise there is no current
      // authority guarantee. Fail closed BEFORE any native write — no unlocked `queryVoid` fallback.
      if (!this.updateAuthority || !locks?.withWriteLockAndReadDependencies) {
        throw new UnsupportedSparqlQueryError(
          'Conditional authorization-resource update requires a prepared native authority and a shared write lock with read dependencies',
          {
            code: 'rdf.sparql.conditional_acl_unsupported',
            capability: 'sparql.update.conditional_acl',
            hint: 'Configure the prepared Mix SPARQL update authority and the hierarchical locker with withWriteLockAndReadDependencies.',
          },
        );
      }
      await locks.withWriteLockAndReadDependencies({ path: queryRequest.baseUrl }, lockDependencies, commit);
    } else if (locks?.withWriteLockAndReadDependencies) {
      await locks.withWriteLockAndReadDependencies({ path: queryRequest.baseUrl }, lockDependencies, commit);
    } else if (locks) {
      await locks.withWriteLock({ path: queryRequest.baseUrl }, commit);
    } else {
      await commit();
    }
    return { pendingActivities, skippedSilentAuthorityLoad };
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
    const credentials = await this.authorizeFor(baseUrl, request, [ PERMISSIONS.Read ]);
    return this.resolveReadAccessScopeForCredentials(baseUrl, credentials, request);
  }

  private async resolveReadAccessScopeForCredentials(baseUrl: string, credentials: Credentials, request?: HttpRequest, authorizationAttempt?: AuthorizationAttempt): Promise<RdfAccessScope> {
    const graphs = await this.engine.listGraphs(baseUrl);
    const deniedGraphUrls: string[] = [];

    for (const graph of graphs) {
      const resourceUrl = this.resourceUrlForGraphValue(graph);
      if (!resourceUrl.startsWith(baseUrl)) {
        continue;
      }
      const allowed = await this.canAuthorizeFor(resourceUrl, credentials, [ PERMISSIONS.Read ], request, authorizationAttempt);
      if (!allowed) {
        deniedGraphUrls.push(graph);
      }
    }
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

  /**
   * Classify an update as the narrow conditional authorization-resource (`.acl`/`.acr`) write.
   *
   * `requested` is true when the update's single write target is an authorization resource. In that
   * case `ok` states whether it is a supported shape: the auxiliary strategy is configured, there is
   * exactly one write graph, every WHERE graph is a fixed in-scope named graph (no variable GRAPH),
   * and no unsupported conditional form (default-graph read, SERVICE, subquery, dataset) is present.
   * `reason` explains an `ok:false` so the caller can fail closed with a capability error.
   */
  private classifyConditionalAuxiliaryWrite(plan: UpdateAccessPlan): {
    requested: boolean;
    ok: boolean;
    writeGraph?: string;
    reason?: string;
  } {
    const writeGraphs = [ ...plan.writeTargets.keys() ];
    const writeIsAuxiliary = writeGraphs.filter(graph =>
      this.authStrategy?.isAuxiliaryIdentifier({ path: this.resourceUrlForGraphValue(graph) }));
    if (writeIsAuxiliary.length === 0) {
      return { requested: false, ok: false };
    }
    const requested = true;
    if (!this.authStrategy) {
      return { requested, ok: false, reason: 'no auxiliary identifier strategy is configured' };
    }
    if (writeGraphs.length !== 1) {
      return { requested, ok: false, reason: 'exactly one authorization-resource write graph is required' };
    }
    if (plan.unsupportedConditionalForm) {
      return { requested, ok: false, reason: plan.unsupportedConditionalForm };
    }
    if (plan.hasVariableGraph) {
      return { requested, ok: false, reason: 'a variable GRAPH is not a supported fixed conditional guard' };
    }
    return { requested, ok: true, writeGraph: writeGraphs[0] };
  }

  /**
   * The finite read scope for the narrow conditional ACL branch: exactly the explicit fixed WHERE
   * read graphs plus the ACL write graph. No whole-directory enumeration; an unrelated private
   * sibling is never touched. `allowedGraphUrls` is the existing Mix delta-validation boundary, so a
   * written ACL must be among these graphs.
   */
  private fixedReadAccessScope(
    baseUrl: string,
    credentials: Credentials,
    writeGraph: string,
    plan: UpdateAccessPlan,
  ): RdfAccessScope {
    const allowed = new Set<string>([ ...plan.whereGraphs, writeGraph ]);
    for (const source of plan.readTargets) {
      allowed.add(source);
    }
    const allowedGraphUrls = [ ...allowed ].sort();
    return {
      basePath: baseUrl,
      mode: 'read',
      principal: credentials.agent?.webId ?? credentials.client?.clientId ?? 'anonymous',
      allowedGraphUrls,
      version: `conditional-acl:${writeGraph}:${allowedGraphUrls.join(',')}`,
    };
  }

  private async authorizeFor(basePath: string, request: HttpRequest, modes: string[], authorizationAttempt?: AuthorizationAttempt): Promise<Credentials> {
    if (modes.length === 0) {
      return this.credentialsExtractor.handleSafe(request);
    }
    const credentials = await this.credentialsExtractor.handleSafe(request);
    await this.authorizeIdentifier(basePath, credentials, modes, request, authorizationAttempt);
    return credentials;
  }

  private async canAuthorizeFor(basePath: string, credentials: Credentials, modes: string[], request?: HttpRequest, authorizationAttempt?: AuthorizationAttempt): Promise<boolean> {
    try {
      await this.authorizeIdentifier(basePath, credentials, modes, request, authorizationAttempt);
      return true;
    } catch (error) {
      if (error instanceof AuthorityDependencyRetryError) throw error;
      this.logger.debug(`ACL/ACR graph denied for ${basePath}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  private async authorizeIdentifier(basePath: string, credentials: Credentials, modes: string[], request?: HttpRequest, authorizationAttempt?: AuthorizationAttempt): Promise<void> {
    const identifier = { path: basePath } satisfies ResourceIdentifier;
    const requestedModes = new IdentifierSetMultiMap<string>();
    for (const mode of modes) {
      requestedModes.add(identifier, mode);
    }
    // One request authorizes the SPARQL target and every graph in scope, and the
    // same identifier repeats when an update touches a graph it already checked.
    // Reuse the decision inside the request only: credentials cannot change and
    // no ACL can be modified by these read-only checks.
    //
    // Cross-request reuse is deliberately absent. A cached allow could outlive a
    // revocation applied by an ordinary PUT/PATCH that never reaches this handler,
    // so every request re-reads the current decision. See the decision register.
    const decisionCache = request === undefined ? undefined : this.requestAuthorizationCache(request);
    const cacheKey = this.authorizationCacheKey(basePath, credentials, modes);
    const requestHit = decisionCache?.get(cacheKey);
    if (requestHit !== undefined) {
      if (requestHit.error !== undefined) throw requestHit.error;
      return;
    }
    try {
      const calculatePermissions = async(): Promise<void> => {
        const availablePermissions = await this.permissionReader.handleSafe({ credentials, requestedModes });
        await this.authorizer.handleSafe({ credentials, requestedModes, availablePermissions });
      };
      if (authorizationAttempt) {
        await metadataRequestContext.run(authorizationAttempt.metadata, () =>
          collectAuthorityDependencies(authorizationAttempt.snapshot, calculatePermissions));
      } else {
        await calculatePermissions();
      }
      decisionCache?.set(cacheKey, {});
    } catch (error: unknown) {
      decisionCache?.set(cacheKey, { error });
      this.logger.debug(`[SubgraphSPARQL] Authorization denied for ${basePath} (${modes.join(', ')})`);
      throw error;
    }
  }

  private requestAuthorizationCache(request: HttpRequest): Map<string, { error?: unknown }> {
    const holder = request as HttpRequest & { __xpodSparqlAuthz?: Map<string, { error?: unknown }> };
    holder.__xpodSparqlAuthz ??= new Map();
    return holder.__xpodSparqlAuthz;
  }

  private authorizationCacheKey(basePath: string, credentials: Credentials, modes: string[]): string {
    const agent = credentials.agent?.webId ?? '';
    const client = credentials.client?.clientId ?? '';
    return JSON.stringify([ basePath, agent, client, [ ...modes ].sort() ]);
  }

  private inspectUpdateGraphs(update: SparqlUpdate, basePath: string): UpdateAccessPlan {
    const plan: UpdateAccessPlan = {
      hasInsert: false,
      hasDelete: false,
      needsReadScope: false,
      readTargets: new Set(),
      writeTargets: new Map(),
      whereGraphs: new Set(),
      hasVariableGraph: false,
      hasConditionalUpdate: false,
      targetEffects: new Map(),
      loadDocuments: [],
      clearGraphs: [],
      graphCopies: [],
    };
    this.collectWhereAnalysis(update, basePath, plan);
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
        plan.hasConditionalUpdate = true;
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
      // A variable graph in a WHERE/NOT EXISTS is an *existence* check, not a write target. It is
      // resolved against the finite graph inventory the engine reports for this scope (injected
      // under the scope lock before the update runs); write targets still require an explicit IRI.
      if (pattern.type === 'graph' && (pattern as { name?: SparqlTerm }).name?.termType !== 'Variable') {
        this.assertGraphTermInScope(pattern.name, basePath);
      }
      const nested = (pattern as any).patterns;
      if (Array.isArray(nested)) {
        this.inspectPatterns(nested as SparqlPattern[], basePath);
      }
      // `FILTER NOT EXISTS { GRAPH <…> { … } }` keeps its graph inside the filter expression, not in
      // a `patterns` array. Without descending into expressions an explicit foreign graph there
      // would never be scope-checked.
      const expression = (pattern as { expression?: unknown }).expression;
      if (expression) {
        this.inspectExpression(expression, basePath);
      }
    }
  }

  /** Descend a filter expression, scope-checking any explicit graphs it contains. */
  private inspectExpression(expression: unknown, basePath: string): void {
    const expr = expression as {
      type?: string;
      args?: unknown[];
      expression?: unknown;
      patterns?: SparqlPattern[];
    } | undefined;
    if (!expr || typeof expr !== 'object') {
      return;
    }
    if (Array.isArray(expr.patterns)) {
      this.inspectPatterns(expr.patterns, basePath);
    }
    if (expr.expression) {
      this.inspectExpression(expr.expression, basePath);
    }
    const patternTypes = new Set([ 'group', 'graph', 'bgp', 'filter', 'union', 'optional', 'minus', 'service' ]);
    for (const arg of expr.args ?? []) {
      if (arg && typeof arg === 'object' && patternTypes.has(String((arg as { type?: string }).type))) {
        this.inspectPatterns([ arg as SparqlPattern ], basePath);
      } else {
        this.inspectExpression(arg, basePath);
      }
    }
  }

  /**
   * Analyse the WHERE of every update operation once: record every fixed named graph (including
   * nested EXISTS/NOT EXISTS), flag a variable GRAPH, and flag an unsupported conditional form
   * (SERVICE, a subquery, a dataset/USING clause, or a default-graph read). The results drive both
   * the strict full-inventory branch (variable GRAPH) and the narrow conditional ACL branch.
   */
  private collectWhereAnalysis(update: SparqlUpdate, basePath: string, plan: UpdateAccessPlan): void {
    this.visitUpdatePatterns(update, name => {
      if (!name) {
        return;
      }
      if (name.termType === 'Variable') {
        plan.hasVariableGraph = true;
        return;
      }
      if (name.termType === 'NamedNode') {
        const pathPart = this.resourceUrlForGraphValue(name.value);
        if (pathPart.startsWith(basePath)) {
          plan.whereGraphs.add(name.value);
        }
      }
    });
    for (const operation of update.updates ?? []) {
      const entry = operation as {
        where?: SparqlPattern[];
        using?: { default?: unknown[]; named?: unknown[] };
        graph?: unknown;
      };
      if (entry.using && ((entry.using.default?.length ?? 0) > 0 || (entry.using.named?.length ?? 0) > 0)) {
        plan.unsupportedConditionalForm ??= 'a dataset/USING clause';
      }
      if (this.hasUnsupportedWhereForm(entry.where ?? [])) {
        plan.unsupportedConditionalForm ??= 'SERVICE or a subquery';
      }
      if (this.hasDefaultGraphRead(entry.where ?? [])) {
        plan.unsupportedConditionalForm ??= 'a default-graph read';
      }
    }
  }

  /** A WHERE containing a SERVICE pattern or a subquery (a pattern with its own `queryType`). */
  private hasUnsupportedWhereForm(patterns: readonly SparqlPattern[]): boolean {
    for (const pattern of patterns) {
      const entry = pattern as { type?: string; queryType?: string; patterns?: SparqlPattern[]; expression?: unknown; args?: unknown[] };
      if (entry.type === 'service' || typeof entry.queryType === 'string') {
        return true;
      }
      if (Array.isArray(entry.patterns) && this.hasUnsupportedWhereForm(entry.patterns)) {
        return true;
      }
      if (entry.type === 'group' && Array.isArray(entry.patterns) && this.hasUnsupportedWhereForm(entry.patterns)) {
        return true;
      }
      if (this.expressionHasUnsupportedForm(entry.expression)) {
        return true;
      }
      for (const arg of entry.args ?? []) {
        if (arg && typeof arg === 'object' && this.hasUnsupportedWhereForm([ arg as SparqlPattern ])) {
          return true;
        }
      }
    }
    return false;
  }

  private expressionHasUnsupportedForm(expression: unknown): boolean {
    const expr = expression as { type?: string; args?: unknown[]; patterns?: SparqlPattern[]; expression?: unknown } | undefined;
    if (!expr || typeof expr !== 'object') {
      return false;
    }
    if (expr.type === 'service' || typeof (expr as { queryType?: string }).queryType === 'string') {
      return true;
    }
    if (Array.isArray(expr.patterns) && this.hasUnsupportedWhereForm(expr.patterns)) {
      return true;
    }
    if (this.expressionHasUnsupportedForm(expr.expression)) {
      return true;
    }
    for (const arg of expr.args ?? []) {
      if (arg && typeof arg === 'object' && this.hasUnsupportedWhereForm([ arg as SparqlPattern ])) {
        return true;
      }
      if (this.expressionHasUnsupportedForm(arg)) {
        return true;
      }
    }
    return false;
  }

  /** A BGP quad/triple that sits directly in WHERE (no GRAPH wrapper) is a default-graph read. */
  private hasDefaultGraphRead(patterns: readonly SparqlPattern[]): boolean {
    for (const pattern of patterns) {
      const entry = pattern as { type?: string; patterns?: SparqlPattern[]; expression?: unknown; triples?: unknown[] };
      // A `graph` pattern puts its inner BGP in a named graph, not the default graph.
      if (entry.type === 'graph') {
        if (this.expressionHasDefaultGraphRead(entry.expression)) {
          return true;
        }
        continue;
      }
      if (entry.type === 'bgp' && (entry.triples?.length ?? 0) > 0) {
        return true;
      }
      if (Array.isArray(entry.patterns) && this.hasDefaultGraphRead(entry.patterns)) {
        return true;
      }
      if (this.expressionHasDefaultGraphRead(entry.expression)) {
        return true;
      }
    }
    return false;
  }

  private expressionHasDefaultGraphRead(expression: unknown): boolean {
    const expr = expression as { type?: string; args?: unknown[]; patterns?: SparqlPattern[]; expression?: unknown } | undefined;
    if (!expr || typeof expr !== 'object') {
      return false;
    }
    if (expr.type === 'graph') {
      return this.expressionHasDefaultGraphRead(expr.expression);
    }
    if (Array.isArray(expr.patterns) && this.hasDefaultGraphRead(expr.patterns)) {
      return true;
    }
    if (this.expressionHasDefaultGraphRead(expr.expression)) {
      return true;
    }
    for (const arg of expr.args ?? []) {
      if (arg && typeof arg === 'object' && (arg as { type?: string }).type !== 'graph'
        && this.hasDefaultGraphRead([ arg as SparqlPattern ])) {
        return true;
      }
      if (this.expressionHasDefaultGraphRead(arg)) {
        return true;
      }
    }
    return false;
  }


  /**
   * Visit every graph-name term and existence group in an update's WHERE, reaching through filter
   * expressions (`FILTER(NOT EXISTS { … })` is an `operation` with a `group` arg, not a `patterns`
   * array). Kept in one place so inspection and finite-binding injection see the same structure.
   */
  private visitUpdatePatterns(
    update: SparqlUpdate,
    onGraph: (name: SparqlTerm | undefined) => void,
    onExistenceGroup?: (patterns: SparqlPattern[]) => void,
  ): void {
    const visitPatterns = (patterns: readonly SparqlPattern[]): void => {
      for (const pattern of patterns) {
        const entry = pattern as { type?: string; name?: SparqlTerm; patterns?: SparqlPattern[]; expression?: unknown };
        if (entry.type === 'graph') {
          onGraph(entry.name);
        }
        if (Array.isArray(entry.patterns)) {
          visitPatterns(entry.patterns);
        }
        if (entry.expression) {
          visitExpression(entry.expression);
        }
      }
    };
    const visitExpression = (expression: unknown): void => {
      const expr = expression as { type?: string; operator?: string; args?: unknown[]; expression?: unknown } | undefined;
      if (!expr || typeof expr !== 'object') {
        return;
      }
      if (expr.type === 'operation' && (expr.operator === 'notexists' || expr.operator === 'exists')) {
        // SPARQLJS wraps a multi-pattern existence block in a `group`, but a single-pattern block is
        // the bare pattern(s) in `args`. Bindings must live in the pattern container the generator
        // actually serializes, so a bare block is normalised into a one-arg group around its original
        // patterns plus the injected VALUES.
        const first = expr.args?.[0] as { type?: string; patterns?: SparqlPattern[] } | undefined;
        if (first?.type === 'group' && Array.isArray(first.patterns)) {
          onExistenceGroup?.(first.patterns);
          visitPatterns(first.patterns);
        } else if (Array.isArray(expr.args)) {
          const original = [ ...(expr.args as SparqlPattern[]) ];
          if (onExistenceGroup) {
            const wrapped = [ ...original ];
            expr.args = [ { type: 'group', patterns: wrapped } ];
            onExistenceGroup(wrapped);
            visitPatterns(wrapped);
          } else {
            visitPatterns(original);
          }
        }
      } else {
        for (const arg of expr.args ?? []) {
          const entry = arg as { type?: string; patterns?: SparqlPattern[] };
          if (entry?.type === 'group' && Array.isArray(entry.patterns)) {
            visitPatterns(entry.patterns);
          } else {
            visitExpression(arg);
          }
        }
      }
      if (expr.expression) {
        visitExpression(expr.expression);
      }
    };
    for (const operation of update.updates ?? []) {
      visitPatterns((operation as { where?: SparqlPattern[] }).where ?? []);
    }
  }

  /**
   * Resolve every variable `GRAPH` used inside an existence guard to the engine's current finite
   * graph inventory for this scope by injecting a `VALUES ?g { … }` inside that same guard.
   *
   * Must run while the scope write lock is held so the inventory cannot change between condition
   * evaluation and commit. The `VALUES` is injected *inside* the existence group (never as an outer
   * join) and keyed by `?variable`, matching SPARQLJS. An empty inventory injects an empty `VALUES`,
   * which the embedded compiler rejects — fail closed rather than dropping the identity constraint.
   */
  private async injectExistenceGraphInventory(
    update: SparqlUpdate,
    basePath: string,
    accessScope?: RdfAccessScope,
    authorizedInventory?: readonly string[],
  ): Promise<boolean> {
    const variables = new Set<string>();
    this.visitUpdatePatterns(update, name => {
      if (name?.termType === 'Variable') {
        variables.add(name.value);
      }
    });
    if (variables.size === 0) {
      return false;
    }
    // The strict existence guard binds the exact inventory that was authorized before the lock; only
    // fall back to a fresh read for legacy shapes that never went through the strict branch.
    const graphs = authorizedInventory === undefined
      ? [ ...await this.engine.listGraphs(basePath, accessScope) ]
      : [ ...authorizedInventory ];
    this.visitUpdatePatterns(update, () => undefined, patterns => {
      const local = new Set<string>();
      this.collectLocalGraphVariables(patterns, local);
      for (const variable of local) {
        patterns.push({
          type: 'values',
          values: graphs.map(graph => ({ [`?${variable}`]: DataFactory.namedNode(graph) })),
        } as unknown as SparqlPattern);
      }
    });
    return true;
  }

  /**
   * Collect variable graph names local to one existence group, treating nested EXISTS/NOT EXISTS as
   * separate scopes. Descending into a nested existence would bind its variable in the outer group,
   * which changes the query's meaning (a correlated inner guard becomes an outer join).
   */
  private collectLocalGraphVariables(patterns: readonly SparqlPattern[], out: Set<string>): void {
    for (const pattern of patterns) {
      const entry = pattern as { type?: string; name?: SparqlTerm; patterns?: SparqlPattern[]; expression?: unknown };
      if (entry.type === 'graph' && entry.name?.termType === 'Variable') {
        out.add(entry.name.value);
      }
      if (Array.isArray(entry.patterns)) {
        this.collectLocalGraphVariables(entry.patterns, out);
      }
      if (entry.expression) {
        this.collectExpressionGraphVariables(entry.expression, out);
      }
    }
  }

  private collectExpressionGraphVariables(expression: unknown, out: Set<string>): void {
    const expr = expression as { type?: string; operator?: string; args?: unknown[]; expression?: unknown } | undefined;
    if (!expr || typeof expr !== 'object') {
      return;
    }
    if (expr.type === 'operation' && (expr.operator === 'exists' || expr.operator === 'notexists')) {
      // A nested existence is its own scope; its variables are bound there.
      return;
    }
    for (const arg of expr.args ?? []) {
      const entry = arg as { type?: string; patterns?: SparqlPattern[] };
      if (Array.isArray(entry?.patterns)) {
        this.collectLocalGraphVariables(entry.patterns, out);
      } else if (entry && typeof entry === 'object' && typeof entry.type === 'string') {
        this.collectLocalGraphVariables([ arg as SparqlPattern ], out);
      } else {
        this.collectExpressionGraphVariables(arg, out);
      }
    }
    if (expr.expression) {
      this.collectExpressionGraphVariables(expr.expression, out);
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

  /**
   * The ONE canonical sidecar/path extraction seam, shared by the ordinary SPARQL path and the closed
   * authorization-observation dispatch. It never guesses a `${room}.sparql` alias or re-parses path.
   */
  private resolveSidecar(request: HttpRequest): { url: URL; basePath: string; baseUrl: string; origin: string; isContainer: boolean } {
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
    const origin = `${url.protocol}//${url.host}`;
    return { url, basePath, baseUrl: `${origin}${basePath}`, origin, isContainer };
  }

  private contentTypeOf(request: HttpRequest): string | undefined {
    const header = request.headers['content-type'] ?? request.headers['Content-Type'];
    const value = Array.isArray(header) ? header[0] : header;
    return value?.split(';')[0].trim().toLowerCase();
  }

  /** Bounded body read for the closed observation record; the ordinary SPARQL path is unchanged. */
  private async readBodyBounded(request: HttpRequest, maxBytes: number): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
      let data = '';
      let bytes = 0;
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => {
        bytes += Buffer.byteLength(chunk, 'utf8');
        if (bytes > maxBytes) {
          reject(new BadRequestHttpError('Authorization observation request body exceeds its bounded budget'));
          request.destroy();
          return;
        }
        data += chunk;
      });
      request.on('end', () => resolve(data));
      request.on('error', reject);
    });
  }

  /**
   * The capability must be the one the authMode-derived runtime branch installed for this handler's
   * actual profile; a mismatched component is a 415, never a qualification. No registry/reflection.
   */
  private qualifiedObservation(): AgentReadObservation {
    if (!this.observation || this.observation.profile !== this.guardedPolicyProfile) {
      throw new UnsupportedMediaTypeHttpError('Authorization observation capability is unavailable for this assembly');
    }
    return this.observation;
  }

  /** The handler's ACTUAL authorization dependencies, compared by the capability before any traversal. */
  private observationActual() {
    return {
      permissionReader: this.permissionReader,
      authorizer: this.authorizer,
      credentialsExtractor: this.credentialsExtractor,
      accessor: this.updateAuthority,
      authorityStore: this.authorityStore,
      locks: this.locks,
      identifierStrategy: this.identifierStrategy,
      authStrategy: this.authStrategy,
      auxiliaryStrategy: this.auxiliaryStrategy,
      podLookup: this.podLookup,
    };
  }

  private async handleAuthorizationObservation(request: HttpRequest, response: HttpResponse): Promise<void> {
    if ((request.method ?? 'GET').toUpperCase() !== 'POST') {
      throw new MethodNotAllowedHttpError([ 'POST' ]);
    }
    const sidecar = this.resolveSidecar(request);
    const observation = this.qualifiedObservation();
    const body = await this.readBodyBounded(request, 2 * 1024 * 1024);
    const context = await this.resolveUsageContext(sidecar.basePath);
    await this.recordBandwidth(context, Buffer.byteLength(body, 'utf8'), 0);
    const payload = await observation.handle(
      request,
      { basePath: sidecar.basePath, baseUrl: sidecar.baseUrl, isContainer: sidecar.isContainer },
      body,
      this.observationActual(),
    );
    await this.recordBandwidth(context, 0, Buffer.byteLength(payload, 'utf8'));
    await this.sendPayload(response, payload, `${AUTHORIZATION_OBSERVATION_MEDIA_TYPE}; charset=utf-8`, context);
  }

  /**
   * Closed A2N profile negotiation. Unlike the A1 observation this runs for BOTH maintained builtin
   * profiles, but only through the capability the same runtime branch installed. A 415/400/403/409/
   * 5xx never carries a declaration; a successful 200 carries the exact declaration media only.
   */
  private async handleAuthorizationProfileNegotiation(request: HttpRequest, response: HttpResponse): Promise<void> {
    if ((request.method ?? 'GET').toUpperCase() !== 'POST') {
      throw new MethodNotAllowedHttpError([ 'POST' ]);
    }
    const sidecar = this.resolveSidecar(request);
    const observation = this.qualifiedObservation();
    const body = await this.readBodyBounded(request, 2 * 1024 * 1024);
    const context = await this.resolveUsageContext(sidecar.basePath);
    await this.recordBandwidth(context, Buffer.byteLength(body, 'utf8'), 0);
    const payload = await observation.negotiate(
      request,
      { basePath: sidecar.basePath, baseUrl: sidecar.baseUrl, isContainer: sidecar.isContainer },
      body,
      this.observationActual(),
    );
    await this.recordBandwidth(context, 0, Buffer.byteLength(payload, 'utf8'));
    await this.sendPayload(response, payload, `${AUTHORIZATION_PROFILE_DECLARATION_MEDIA_TYPE}; charset=utf-8`, context);
  }

  private async extractQuery(request: HttpRequest, method: string): Promise<QueryRequest> {
    const { url, basePath, isContainer } = this.resolveSidecar(request);

    let query: string | null = null;
    let ingressBytes = 0;
    let policyGuard: GuardedPolicySnapshot | undefined;

    if (method === 'GET') {
      query = url.searchParams.get('query');
      if (query) {
        ingressBytes += Buffer.byteLength(query, 'utf8');
      }
    } else {
      const contentTypeHeader = request.headers['content-type'] ?? request.headers['Content-Type'];
      const contentType = Array.isArray(contentTypeHeader) ? contentTypeHeader[0] : contentTypeHeader;
      const normalized = contentType?.split(';')[0].trim().toLowerCase();

      if (normalized === GUARDED_SPARQL_MEDIA_TYPE) {
        if (this.guardedPolicyProfile !== 'wac-ground-v1' && this.guardedPolicyProfile !== 'acp-ground-v1') {
          throw new UnsupportedMediaTypeHttpError('Guarded policy profile is unavailable');
        }
        const body = await this.readBody(request);
        ingressBytes += Buffer.byteLength(body, 'utf8');
        try {
          const envelope = parseGuardedPolicyUpdate(JSON.parse(body));
          query = envelope.update;
          policyGuard = envelope.guard;
        } catch { throw new BadRequestHttpError('Malformed guarded policy envelope'); }
      } else if (normalized === 'application/sparql-query'  || normalized === 'application/sparql-update') {
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
      ...(policyGuard ? { policyGuard } : {}),
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
