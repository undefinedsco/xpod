import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { HttpHandler } from '@solid/community-server';
import type { HttpHandlerInput, HttpRequest, HttpResponse } from '@solid/community-server';
import {
  getLoggerFor,
  NotImplementedHttpError,
  MethodNotAllowedHttpError,
  BadRequestHttpError,
  UnsupportedMediaTypeHttpError,
  IdentifierSetMultiMap,
  AccessMode,
} from '@solid/community-server';
import type {
  CredentialsExtractor,
  PermissionReader,
  Authorizer,
  ResourceIdentifier,
} from '@solid/community-server';
import type { Term, Literal, Variable, Quad as RdfQuad } from '@rdfjs/types';
import { Writer } from 'n3';
import { Parser } from 'sparqljs';
import type {
  Update as SparqlUpdate,
  InsertDeleteOperation as SparqlInsertDeleteOperation,
  Quads as SparqlQuads,
  Pattern as SparqlPattern,
  GraphOrDefault as SparqlGraphOrDefault,
  IriTerm as SparqlIriTerm,
  Term as SparqlTerm,
} from 'sparqljs';
import { SubgraphQueryEngine } from '../storage/sparql/SubgraphQueryEngine';
import { getIdentityDatabase } from '../identity/drizzle/db';
import { PodLookupRepository } from '../identity/drizzle/PodLookupRepository';
import { UsageRepository } from '../storage/quota/UsageRepository';
import { createBandwidthThrottleTransform } from '../util/stream/BandwidthThrottleTransform';

const ALLOWED_METHODS = [ 'GET', 'POST', 'OPTIONS' ];

interface QueryRequest {
  basePath: string;
  query: string;
  origin: string;
  method: string;
  ingressBytes: number;
}

interface SubgraphSparqlHttpHandlerOptions {
  resourceSuffix?: string;
  containerSuffix?: string;
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
  private readonly resourceSuffix: string;
  private readonly containerSuffix: string;
  private readonly podLookup?: PodLookupRepository;
  private readonly usageRepo?: UsageRepository;
  private readonly defaultBandwidthLimit?: number | null;

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
    this.resourceSuffix = options.resourceSuffix ?? '.sparql';
    this.containerSuffix = options.containerSuffix ?? '/sparql';
    this.defaultBandwidthLimit = this.normalizeLimit(options.defaultAccountBandwidthLimitBps);

    // Identity DB is used for pod lookup (to resolve accountId/podId from URL)
    if (options.identityDbUrl) {
      const db = getIdentityDatabase(options.identityDbUrl);
      this.podLookup = new PodLookupRepository(db);
    }

    // Usage DB can be separate from identity DB (decoupled usage tracking)
    const usageDbUrl = options.usageDbUrl ?? options.identityDbUrl;
    if (usageDbUrl) {
      const usageDb = getIdentityDatabase(usageDbUrl);
      this.usageRepo = new UsageRepository(usageDb);
    }
  }

  public override async canHandle({ request }: HttpHandlerInput): Promise<void> {
    const path = this.parseUrl(request).pathname;
    const isResource = path.endsWith(this.resourceSuffix);
    const isContainer = path.endsWith(this.containerSuffix);
    if (!isResource && !isContainer) {
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

    const queryRequest = await this.extractQuery(request, method);
    const context = await this.resolveUsageContext(queryRequest.basePath);
    await this.recordBandwidth(context, queryRequest.ingressBytes, 0);
    const parser = new Parser({ baseIRI: `${queryRequest.origin}${queryRequest.basePath}` });
    const parsed = parser.parse(queryRequest.query);

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
  }

  private async executeSelect(request: HttpRequest, { query, basePath }: QueryRequest, response: HttpResponse, context: UsageContext | undefined): Promise<void> {
    await this.authorizeFor(basePath, request, [ AccessMode.read ]);
    const bindingsStream: any = await this.engine.queryBindings(query, basePath);
    const metadata = typeof bindingsStream.metadata === 'function' ? await bindingsStream.metadata() : undefined;
    const vars = metadata?.variables?.map((variable: Variable): string => variable.value) ?? [];
    const results: Record<string, unknown>[] = [];

    for await (const binding of bindingsStream as AsyncIterable<any>) {
      const row: Record<string, unknown> = {};
      for (const [ name, term ] of binding) {
        row[name] = this.termToJson(term);
      }
      results.push(row);
    }

    const payload = {
      head: { vars },
      results: { bindings: results },
    };

    await this.sendPayload(response, JSON.stringify(payload), 'application/sparql-results+json; charset=utf-8', context);
  }

  private async executeAsk(request: HttpRequest, { query, basePath }: QueryRequest, response: HttpResponse, context: UsageContext | undefined): Promise<void> {
    await this.authorizeFor(basePath, request, [ AccessMode.read ]);
    const result = await this.engine.queryBoolean(query, basePath);
    const payload = {
      head: {},
      boolean: result,
    };
    await this.sendPayload(response, JSON.stringify(payload), 'application/sparql-results+json; charset=utf-8', context);
  }

  private async executeConstruct(request: HttpRequest, { query, basePath }: QueryRequest, response: HttpResponse, context: UsageContext | undefined): Promise<void> {
    await this.authorizeFor(basePath, request, [ AccessMode.read ]);
    const quadStream = await this.engine.queryQuads(query, basePath);
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

    const { hasInsert, hasDelete } = this.inspectUpdateGraphs(parsed, queryRequest.basePath);
    const modes: AccessMode[] = [];
    if (hasInsert) {
      modes.push(AccessMode.append);
    }
    if (hasDelete) {
      modes.push(AccessMode.delete);
    }
    await this.authorizeFor(queryRequest.basePath, request, modes);

    await this.engine.queryVoid(queryRequest.query, queryRequest.basePath);
    await this.refreshUsage(queryRequest.basePath);

    response.statusCode = 204;
    response.setHeader('Cache-Control', 'no-store');
    response.end();
  }

  private async sendPayload(response: HttpResponse, payload: string | Buffer, contentType: string, context: UsageContext | undefined, statusCode = 200): Promise<void> {
    const buffer = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
    response.statusCode = statusCode;
    response.setHeader('Content-Type', contentType);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Length', buffer.length);
    const limit = context ? await this.resolveBandwidthLimit(context) : this.defaultBandwidthLimit;
    await this.streamWithLimit(response, buffer, limit);
    await this.recordBandwidth(context, 0, buffer.length);
  }

  private async streamWithLimit(response: HttpResponse, buffer: Buffer, limit?: number | null): Promise<void> {
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

  private async authorizeFor(basePath: string, request: HttpRequest, modes: AccessMode[]): Promise<void> {
    if (modes.length === 0) {
      return;
    }
    const identifier = { path: basePath } satisfies ResourceIdentifier;
    const requestedModes = new IdentifierSetMultiMap<AccessMode>();
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
      throw new BadRequestHttpError('Graph IRIs must be explicit when using the .sparql update endpoint.');
    }
    if (term.termType === 'NamedNode') {
      if (!term.value.startsWith(basePath)) {
        throw new BadRequestHttpError(`Graph ${term.value} is outside of ${basePath}.`);
      }
      return;
    }
    if ((term as any).default === true) {
      return;
    }
    throw new BadRequestHttpError('Unsupported graph target in SPARQL update.');
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

    let basePath: string;
    if (path.endsWith(this.containerSuffix)) {
      // Container endpoint: /alice/sparql → /alice/
      basePath = path.slice(0, -this.containerSuffix.length + 1);
      if (!basePath.endsWith('/')) {
        basePath += '/';
      }
    } else if (path.endsWith(this.resourceSuffix)) {
      // Resource endpoint: /alice/profile.ttl.sparql → /alice/profile.ttl
      basePath = path.slice(0, -this.resourceSuffix.length);
    } else {
      throw new NotImplementedHttpError('Request is not targeting a subgraph SPARQL endpoint.');
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

    return {
      basePath,
      query: query.trim(),
      origin: `${url.protocol}//${url.host}`,
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
}
