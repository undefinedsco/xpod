import { Readable } from 'node:stream';
import { getLoggerFor } from 'global-logger-factory';
import { pipeline } from 'node:stream/promises';
import { HttpHandler } from '@solid/community-server';
import type { HttpHandlerInput, HttpRequest, HttpResponse } from '@solid/community-server';
import {
  NotImplementedHttpError,
  MethodNotAllowedHttpError,
  BadRequestHttpError,
  UnsupportedMediaTypeHttpError,
  IdentifierSetMultiMap,
  HttpError,
} from '@solid/community-server';
import { PERMISSIONS } from '@solidlab/policy-engine';
import type {
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
import { getIdentityDatabase } from '../identity/drizzle/db';
import { PodLookupRepository } from '../identity/drizzle/PodLookupRepository';
import { UsageRepository } from '../storage/quota/UsageRepository';
import { createBandwidthThrottleTransform } from '../util/stream/BandwidthThrottleTransform';

const ALLOWED_METHODS = [ 'GET', 'POST', 'OPTIONS' ];

interface QueryRequest {
  basePath: string;
  baseUrl: string;  // Full URL for authorization (origin + basePath)
  query: string;
  origin: string;
  method: string;
  ingressBytes: number;
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
  private readonly generator = new Generator();

  private static readonly XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';

  public constructor(
    queryEngine: SubgraphQueryEngine,
    credentialsExtractor: CredentialsExtractor,
    permissionReader: PermissionReader,
    authorizer: Authorizer,
    options: SubgraphSparqlHttpHandlerOptions = {},
  ) {
    super();
    this.engine = queryEngine;
    this.credentialsExtractor = credentialsExtractor;
    this.permissionReader = permissionReader;
    this.authorizer = authorizer;
    this.sidecarPath = options.sidecarPath ?? '/-/sparql';
    this.defaultBandwidthLimit = this.normalizeLimit(options.defaultAccountBandwidthLimitBps);

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

      // WORKAROUND: Comunica crashes if ASK query has a LIMIT clause ("Expected bindings but got boolean").
      // ASK results are boolean and cannot be sliced, so LIMIT is semantically redundant but syntactically valid.
      // We strip it here to protect the engine.
      // console.log('Parsed Query Type:', parsed.queryType, 'Limit:', (parsed as any).limit); 
      if (parsed.queryType === 'ASK' && (parsed as any).limit !== undefined) {
        this.logger.warn(`Stripping LIMIT from ASK query to prevent Comunica crash. Original limit: ${JSON.stringify((parsed as any).limit)}`);
        delete (parsed as any).limit;
        queryRequest.query = this.generator.stringify(parsed);
        this.logger.warn(`Sanitized Query: ${queryRequest.query}`);
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
        this.logger.error(`SPARQL sidecar error ${error.statusCode} (${this.getRequestId(request)}): ${error.message || 'HttpError'}`);
        this.sendErrorResponse(response, error.statusCode, error.message);
        return;
      }
      // Re-throw unknown errors for CSS error handling
      this.logger.error(`SPARQL sidecar unexpected error (${this.getRequestId(request)}): ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  private sendErrorResponse(response: HttpResponse, statusCode: number, message: string): void {
    response.statusCode = statusCode;
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    response.end(message);
  }

  private async executeSelect(request: HttpRequest, { query, basePath, baseUrl }: QueryRequest, response: HttpResponse, context: UsageContext | undefined): Promise<void> {
    await this.authorizeFor(baseUrl, request, [ PERMISSIONS.Read ]);

    let vars: string[] = [];
    const results: Record<string, unknown>[] = [];
    const seenVars = new Set<string>();

    try {
      const bindingsStream: any = await this.engine.queryBindings(query, baseUrl);
      const metadata = typeof bindingsStream.metadata === 'function' ? await bindingsStream.metadata() : undefined;
      vars = metadata?.variables?.map((variable: Variable): string => variable.value) ?? [];

      for await (const binding of bindingsStream as AsyncIterable<any>) {
        const row: Record<string, unknown> = {};
        for (const [ variable, term ] of binding) {
          // variable is a Variable object; use .value to get the string name
          const name = typeof variable === 'string' ? variable : variable.value;
          row[name] = this.termToJson(term);
          seenVars.add(name);
        }
        results.push(row);
      }

      // Fallback: if metadata didn't provide vars, extract from bindings
      if (vars.length === 0 && seenVars.size > 0) {
        vars = Array.from(seenVars);
      }
    } catch (error: unknown) {
      // Comunica throws when projected variables are not assigned (i.e., no results)
      // Return empty results instead of erroring
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('are used in the projection result, but are not assigned')) {
        this.logger.debug(`Query returned no results: ${message}`);
        // Extract variable names from the error message or query
        const varMatch = message.match(/Variables '([^']+)'/);
        if (varMatch) {
          vars = varMatch[1].split(',').map((v) => v.trim().replace(/^\?/, ''));
        }
      } else {
        throw error;
      }
    }

    const payload = {
      head: { vars },
      results: { bindings: results },
    };

    await this.sendPayload(response, JSON.stringify(payload), 'application/sparql-results+json; charset=utf-8', context);
  }

  private async executeAsk(request: HttpRequest, { query, basePath, baseUrl }: QueryRequest, response: HttpResponse, context: UsageContext | undefined): Promise<void> {
    await this.authorizeFor(baseUrl, request, [ PERMISSIONS.Read ]);
    const result = await this.engine.queryBoolean(query, baseUrl);
    const payload = {
      head: {},
      boolean: result,
    };
    await this.sendPayload(response, JSON.stringify(payload), 'application/sparql-results+json; charset=utf-8', context);
  }

  private async executeConstruct(request: HttpRequest, { query, basePath, baseUrl }: QueryRequest, response: HttpResponse, context: UsageContext | undefined): Promise<void> {
    await this.authorizeFor(baseUrl, request, [ PERMISSIONS.Read ]);
    const quadStream = await this.engine.queryQuads(query, baseUrl);
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

  private async executeUpdate(queryRequest: QueryRequest, parsed: SparqlUpdate, request: HttpRequest, response: HttpResponse, context: UsageContext | undefined): Promise<void> {
    if (queryRequest.method !== 'POST') {
      throw new MethodNotAllowedHttpError([ 'POST' ]);
    }

    const { hasInsert, hasDelete } = this.inspectUpdateGraphs(parsed, queryRequest.baseUrl);
    const modes: string[] = [];
    if (hasInsert) {
      modes.push(PERMISSIONS.Append);
    }
    if (hasDelete) {
      modes.push(PERMISSIONS.Delete);
    }
    await this.authorizeFor(queryRequest.baseUrl, request, modes);

    const rewritten = this.rewriteDefaultGraphUpdates(parsed, queryRequest.baseUrl);
    this.logger.verbose(`[SubgraphSPARQL] Rewritten Query: ${rewritten}`);

    await this.engine.queryVoid(rewritten, queryRequest.baseUrl);
    await this.refreshUsage(queryRequest.baseUrl);

    response.statusCode = 204;
    response.setHeader('Cache-Control', 'no-store');
    response.end();
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

  private async authorizeFor(basePath: string, request: HttpRequest, modes: string[]): Promise<void> {
    if (modes.length === 0) {
      return;
    }
    const identifier = { path: basePath } satisfies ResourceIdentifier;
    const requestedModes = new IdentifierSetMultiMap<string>();
    for (const mode of modes) {
      requestedModes.add(identifier, mode);
    }
    const credentials = await this.credentialsExtractor.handleSafe(request);
    const availablePermissions = await this.permissionReader.handleSafe({ credentials, requestedModes });
    await this.authorizer.handleSafe({ credentials, requestedModes, availablePermissions });
  }

  private inspectUpdateGraphs(update: SparqlUpdate, basePath: string): { hasInsert: boolean; hasDelete: boolean } {
    let hasInsert = false;
    let hasDelete = false;
    for (const operation of update.updates ?? []) {
      if (!this.isInsertDeleteOperation(operation)) {
        throw new BadRequestHttpError('SPARQL update management operations are not supported.');
      }

      if (operation.updateType === 'insert' ||
        (operation.updateType === 'insertdelete' && (operation.insert?.length ?? 0) > 0)) {
        hasInsert = true;
      }

      if (operation.updateType === 'delete' || operation.updateType === 'deletewhere' ||
        (operation.updateType === 'insertdelete' && (operation.delete?.length ?? 0) > 0)) {
        hasDelete = true;
      }

      if (operation.graph) {
        this.assertGraphInScope(operation.graph, basePath);
      }

      if (operation.updateType === 'insert' || operation.updateType === 'insertdelete') {
        this.inspectQuads(operation.insert ?? [], basePath);
      }

      if (operation.updateType === 'delete' || operation.updateType === 'insertdelete' || operation.updateType === 'deletewhere') {
        this.inspectQuads(operation.delete ?? [], basePath);
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
    return { hasInsert, hasDelete };
  }

  private inspectQuads(quads: SparqlQuads[], basePath: string): void {
    for (const quad of quads) {
      if (quad.type === 'graph') {
        this.assertGraphTermInScope(quad.name, basePath);
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

  private assertGraphInScope(graph: SparqlGraphOrDefault | SparqlIriTerm, basePath: string): void {
    if ('default' in graph && graph.default) {
      return;
    }
    if ('name' in graph) {
      const name = graph.name;
      if (name) {
        this.assertGraphTermInScope(name, basePath);
      }
    } else if ('value' in graph) {
      this.assertGraphTermInScope(graph, basePath);
    }
  }

  private assertGraphTermInScope(term: SparqlTerm, basePath: string): void {
    if (!term) {
      return;
    }
    if (term.termType === 'Variable') {
      throw new BadRequestHttpError('Graph IRIs must be explicit when using the /-/sparql update endpoint.');
    }
    if (term.termType === 'NamedNode') {
      // Graph can be either basePath or prefix:basePath (e.g., meta:http://...)
      // Extract the path part after optional prefix (anything before first colon that's not part of http:)
      const graphValue = term.value;
      let pathPart = graphValue;
      
      // Check if it has a prefix like "meta:" or "acl:" (not "http:" or "https:")
      const prefixMatch = graphValue.match(/^([a-z]+):(?!\/\/)/i);
      if (prefixMatch) {
        pathPart = graphValue.slice(prefixMatch[0].length);
      }
      
      if (!pathPart.startsWith(basePath)) {
        throw new BadRequestHttpError(`Graph ${term.value} is outside of ${basePath}.`);
      }
      return;
    }
    if ((term as any).default === true) {
      return;
    }
    throw new BadRequestHttpError('Unsupported graph target in SPARQL update.');
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
    // If the base looks like a container (no file extension), normalize with trailing slash.
    const hasExtension = /\.[^/]+$/.test(basePath);
    if (!hasExtension && !basePath.endsWith('/')) {
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
    return {
      basePath,
      baseUrl: `${origin}${basePath}`,
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
      .replace(/\b/g, '\\b');
  }

  private isInsertDeleteOperation(operation: SparqlUpdate['updates'][number]): operation is SparqlInsertDeleteOperation {
    return typeof (operation as SparqlInsertDeleteOperation).updateType === 'string';
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
