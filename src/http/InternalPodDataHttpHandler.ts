import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { getLoggerFor } from 'global-logger-factory';
import { Parser } from 'sparqljs';
import {
  BasicRepresentation,
  HttpHandler,
  NotImplementedHttpError,
  RepresentationMetadata,
  type BodyParser,
  type HttpHandlerInput,
  type HttpRequest,
  type HttpResponse,
  type Patch,
  type Representation,
  type ResourceStore,
} from '@solid/community-server';
import {
  createAiConnectionsServiceAccess,
  isGatewayAccessKeySparqlEndpoint,
  resolveGatewayAccessKeyResourceUrl,
  resolveGatewayAccessKeySecretResourceUrl,
} from '../api/ai-gateway/service-access/AiConnectionsServiceAccess';
import { createAiConfigResourceUrls } from '../api/ai-gateway/service-access/AiConfigServiceAccess';
import {
  isLoopbackRemoteAddress,
  verifyGatewayAdminProxyHeaders,
  type GatewayAdminProxyIntent,
} from '../runtime/GatewayAdminProxyAuth';
import { withDirectDataRead } from '../storage/ResourceReadContext';

export interface InternalPodDataHttpHandlerOptions {
  resourceStore: ResourceStore;
  gatewayAdminProxyAuthSecret?: string;
  patchBodyParser?: BodyParser;
  sparqlHandler?: InternalPodDataTrustedSparqlHandler;
  baseUrl?: string;
  basePath?: string;
}

/** Narrow trusted bridge used only after the signed internal intent has been
 * validated. The implementation must re-check the owner/collection boundary. */
export interface InternalPodDataTrustedSparqlHandler {
  handleTrustedInternalSelect(input: {
    ownerWebId: string;
    endpointUrl: string;
    query: string;
    request: HttpRequest;
    response: HttpResponse;
  }): Promise<void>;
  handleTrustedInternalUpdate(input: {
    ownerWebId: string;
    endpointUrl: string;
    query: string;
    request: HttpRequest;
    response: HttpResponse;
  }): Promise<void>;
}

interface InternalPodDataHttpHandlerNonceOptions {
  nonceTtlMs?: number;
  nonceMaxEntries?: number;
  now?: () => number;
}

type InternalPodDataMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

const ALLOWED_METHODS = new Set([ 'GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE' ]);
const DEFAULT_NONCE_TTL_MS = 120_000;
const DEFAULT_NONCE_MAX_ENTRIES = 10_000;
const MODEL_QUERY_MAX_BODY_BYTES = 256 * 1024;

export class InternalPodDataHttpHandler extends HttpHandler {
  protected readonly logger = getLoggerFor(this);
  private readonly resourceStore: ResourceStore;
  private readonly gatewayAdminProxyAuthSecret?: string;
  private readonly patchBodyParser?: BodyParser;
  private readonly sparqlHandler?: InternalPodDataTrustedSparqlHandler;
  private readonly deploymentBaseUrl?: URL;
  private readonly basePath: string;
  private readonly seenNonces: BoundedTtlNonceCache;

  public constructor(options: InternalPodDataHttpHandlerOptions) {
    super();
    this.resourceStore = options.resourceStore;
    this.gatewayAdminProxyAuthSecret = options.gatewayAdminProxyAuthSecret ?? process.env.XPOD_GATEWAY_ADMIN_PROXY_AUTH_SECRET;
    this.patchBodyParser = options.patchBodyParser;
    this.sparqlHandler = options.sparqlHandler;
    this.deploymentBaseUrl = this.parseOptionalUrl(options.baseUrl ?? process.env.CSS_BASE_URL);
    this.basePath = options.basePath ?? '/.internal/pod-data';
    const nonceOptions = options as InternalPodDataHttpHandlerOptions & InternalPodDataHttpHandlerNonceOptions;
    this.seenNonces = new BoundedTtlNonceCache({
      ttlMs: nonceOptions.nonceTtlMs ?? DEFAULT_NONCE_TTL_MS,
      maxEntries: nonceOptions.nonceMaxEntries ?? DEFAULT_NONCE_MAX_ENTRIES,
      now: nonceOptions.now,
    });
  }

  public override async canHandle({ request }: HttpHandlerInput): Promise<void> {
    if (this.requestPathname(request) !== this.basePath) {
      throw new NotImplementedHttpError('Not an internal Pod data request.');
    }
  }

  public override async handle({ request, response }: HttpHandlerInput): Promise<void> {
    if (this.requestPathname(request) !== this.basePath) {
      throw new NotImplementedHttpError('Not an internal Pod data request.');
    }

    const intent = this.verifyRequest(request);
    if (!intent) {
      this.writeNotFound(response);
      return;
    }

    try {
      await withDirectDataRead(() => this.delegate(request, response, intent));
    } catch (error: unknown) {
      if (isHttpNotFound(error)) {
        if (intent.method === 'GET') {
          this.writeEmptyGraph(response);
        } else {
          this.writeNotFound(response);
        }
        return;
      }
      throw error;
    }
  }

  private verifyRequest(request: HttpRequest): GatewayAdminProxyIntent | undefined {
    const method = request.method?.toUpperCase();
    if (!ALLOWED_METHODS.has(method ?? '')) {
      this.logRejectedRequest('method_not_allowed');
      return undefined;
    }
    if (!isLoopbackRemoteAddress(request.socket.remoteAddress)) {
      this.logRejectedRequest('non_loopback_transport');
      return undefined;
    }

    const verification = verifyGatewayAdminProxyHeaders({
      headers: request.headers,
      secret: this.gatewayAdminProxyAuthSecret,
      method,
      url: request.url,
    });
    if (!verification.valid || !verification.originalClientLoopback || !verification.intent || !verification.nonce) {
      this.logRejectedRequest(verification.reason ?? 'invalid_runtime_marker');
      return undefined;
    }
    if (!this.intentMatchesRequest(verification.intent, method as InternalPodDataMethod)) {
      this.logRejectedRequest('intent_mismatch');
      return undefined;
    }
    if (!this.isHostedOwnerResource(verification.intent)) {
      this.logRejectedRequest('owner_resource_outside_deployment');
      return undefined;
    }
    if (!this.isAllowedAiConnectionResource(verification.intent)) {
      this.logRejectedRequest('resource_not_allowed');
      return undefined;
    }
    if (!this.seenNonces.consume(verification.nonce)) {
      this.logRejectedRequest('nonce_rejected');
      return undefined;
    }
    return verification.intent;
  }

  private logRejectedRequest(reason: string): void {
    this.logger.warn(`Rejected internal Pod data request: ${reason}`);
  }

  private intentMatchesRequest(intent: GatewayAdminProxyIntent, method: InternalPodDataMethod): boolean {
    if (intent.method !== method) {
      return false;
    }
    if (intent.scopes.length === 0) {
      return false;
    }
    if (intent.principalKind === 'gateway-key-verifier') {
      return intent.scopes.length === 1 && (
        (intent.scopes[0] === 'ai:gateway-key:verify' && (method === 'GET' || method === 'HEAD' || method === 'POST'))
        || (intent.scopes[0] === 'ai:gateway-key:touch' && (method === 'GET' || method === 'HEAD' || method === 'PATCH'))
      );
    }
    if (method === 'POST') {
      const endpointKind = trustedSparqlEndpointKind(resourceOwnerWebId(intent), intent.resourceUrl);
      if (endpointKind === 'settings') {
        return intentHasScope(intent, 'ai:credentials:read') || intentHasScope(intent, 'ai:credentials:write');
      }
      if (endpointKind === 'models') {
        return intentHasScope(intent, 'ai:credentials:read');
      }
      if (endpointKind === 'gatewayAccessKeys') {
        return intentHasScope(intent, 'ai:credentials:read');
      }
    }
    return intentHasScope(
      intent,
      method === 'GET' || method === 'HEAD' ? 'ai:credentials:read' : 'ai:credentials:write',
    );
  }

  private isHostedOwnerResource(intent: GatewayAdminProxyIntent): boolean {
    if (!this.deploymentBaseUrl) {
      return false;
    }

    let resourceUrl: URL;
    try {
      resourceUrl = new URL(intent.resourceUrl);
    } catch {
      return false;
    }
    const podRoot = podRootFromIntent(intent);
    if (!podRoot || !this.isInsideDeployment(podRoot) || !this.isInsideDeployment(resourceUrl)) {
      return false;
    }

    return resourceUrl.origin === podRoot.origin &&
      resourceUrl.pathname.startsWith(podRoot.pathname);
  }

  private isAllowedAiConnectionResource(intent: GatewayAdminProxyIntent): boolean {
    let resourceUrl: URL;
    try {
      resourceUrl = new URL(intent.resourceUrl);
    } catch {
      return false;
    }
    if (intent.principalKind === 'gateway-key-verifier') {
      return isAllowedGatewayKeyVerifierResource(intent, resourceUrl);
    }
    const resourceOwner = resourceOwnerWebId(intent);
    const sparqlQuery = trustedSparqlQueryForOwner(resourceOwner, resourceUrl);
    if (sparqlQuery !== undefined) {
      return intent.method === 'GET';
    }
    if (trustedSparqlEndpointKind(resourceOwner, intent.resourceUrl) !== undefined) {
      return intent.method === 'POST' && !resourceUrl.search && !resourceUrl.hash;
    }
    if (resourceUrl.hash || resourceUrl.search) {
      return false;
    }
    const allowed = createAiConnectionsServiceAccess({
      ownerWebId: resourceOwner,
      serviceWebId: intent.ownerWebId,
    }).resources.map((resource) => resource.url);
    allowed.push(...createAiConfigResourceUrls(resourceOwner));
    return allowed.includes(resourceUrl.href);
  }

  private async delegate(
    request: HttpRequest,
    response: HttpResponse,
    intent: GatewayAdminProxyIntent,
  ): Promise<void> {
    const resourceUrl = new URL(intent.resourceUrl);
    const sparqlOperation = await trustedSparqlOperationForRequest(
      request,
      resourceOwnerWebId(intent),
      resourceUrl,
      intent.method,
    );
    if (sparqlOperation !== undefined) {
      if (!this.sparqlHandler) {
        throw new NotImplementedHttpError('Internal settings SPARQL delegation is not configured.');
      }
      if (!intentAllowsSparqlOperation(intent, sparqlOperation.kind)) {
        this.logRejectedRequest(`sparql_scope_mismatch:${sparqlOperation.kind}`);
        this.writeNotFound(response);
        return;
      }
      if (intent.method === 'POST' && intent.bodyDigest !== sparqlOperation.bodyDigest) {
        this.logRejectedRequest(
          `sparql_body_digest_mismatch:${intent.bodyDigest?.slice(0, 12) ?? 'missing'}:${sparqlOperation.bodyDigest?.slice(0, 12) ?? 'missing'}`,
        );
        this.writeNotFound(response);
        return;
      }
      const input = {
        ownerWebId: resourceOwnerWebId(intent),
        endpointUrl: intent.resourceUrl,
        query: sparqlOperation.sparql,
        request,
        response,
      };
      if (sparqlOperation.kind === 'query') {
        await this.sparqlHandler.handleTrustedInternalSelect(input);
      } else {
        await this.sparqlHandler.handleTrustedInternalUpdate(input);
      }
      return;
    }
    if (trustedSparqlEndpointKind(resourceOwnerWebId(intent), intent.resourceUrl) !== undefined) {
      this.logRejectedRequest(
        `sparql_operation_unsupported:${firstHeader(request.headers['content-type']) ?? 'missing-content-type'}`,
      );
      this.writeNotFound(response);
      return;
    }
    const identifier = { path: intent.resourceUrl };
    switch (intent.method) {
      case 'GET': {
        const representation = await this.resourceStore.getRepresentation(identifier, resourceReadPreferences(intent));
        response.statusCode = 200;
        response.setHeader('Content-Type', representation.metadata.contentType ?? 'text/turtle');
        await this.pipeRepresentation(representation, response);
        return;
      }
      case 'HEAD': {
        const representation = await this.resourceStore.getRepresentation(identifier, resourceReadPreferences(intent));
        response.statusCode = 200;
        response.setHeader('Content-Type', representation.metadata.contentType ?? 'text/turtle');
        (representation.data as Readable).destroy();
        response.end();
        return;
      }
      case 'PUT': {
        await this.resourceStore.setRepresentation(identifier, this.createRepresentation(request, intent.resourceUrl));
        response.statusCode = 204;
        response.end();
        return;
      }
      case 'PATCH': {
        await this.resourceStore.modifyResource(identifier, await this.createPatch(request, intent.resourceUrl));
        response.statusCode = 204;
        response.end();
        return;
      }
      case 'DELETE': {
        await this.resourceStore.deleteResource(identifier);
        response.statusCode = 204;
        response.end();
      }
    }
  }

  private createRepresentation(request: HttpRequest, resourceUrl: string): Representation {
    const contentType = firstHeader(request.headers['content-type']) ?? 'text/turtle';
    return new BasicRepresentation(
      request,
      new RepresentationMetadata({ path: resourceUrl }, contentType),
    );
  }

  private async createPatch(request: HttpRequest, resourceUrl: string): Promise<Patch> {
    if (!this.patchBodyParser) {
      throw new NotImplementedHttpError('Internal Pod data PATCH requires a PatchBodyParser.');
    }
    const contentType = firstHeader(request.headers['content-type']) ?? 'application/sparql-update';
    const metadata = new RepresentationMetadata({ path: resourceUrl }, contentType);
    return this.patchBodyParser.handleSafe({ request, metadata }) as Promise<Patch>;
  }

  private async pipeRepresentation(representation: Representation, response: HttpResponse): Promise<void> {
    await pipeline(representation.data as Readable, response);
  }

  private writeNotFound(response: HttpResponse): void {
    response.statusCode = 404;
    response.setHeader('Cache-Control', 'no-store');
    response.end('Not Found');
  }

  private writeEmptyGraph(response: HttpResponse): void {
    response.statusCode = 200;
    response.setHeader('Content-Type', 'text/turtle');
    response.setHeader('Cache-Control', 'no-store');
    response.end();
  }

  private requestPathname(request: HttpRequest): string | undefined {
    const requestUrl = request.url ?? '/';
    try {
      // Route ownership is path-based. Do not let an untrusted or proxy-shaped
      // Host header make URL parsing throw and silently skip this first handler.
      return requestUrl.startsWith('/')
        ? new URL(requestUrl, 'http://xpod.internal').pathname
        : new URL(requestUrl).pathname;
    } catch {
      return undefined;
    }
  }

  private parseOptionalUrl(value: string | undefined): URL | undefined {
    if (!value) {
      return undefined;
    }
    try {
      return new URL(ensureTrailingSlash(value));
    } catch {
      return undefined;
    }
  }

  private isInsideDeployment(url: URL): boolean {
    return this.deploymentBaseUrl !== undefined &&
      url.origin === this.deploymentBaseUrl.origin &&
      url.pathname.startsWith(this.deploymentBaseUrl.pathname);
  }

}

function isHttpNotFound(error: unknown): boolean {
  return typeof error === 'object' &&
    error !== null &&
    ('statusCode' in error ? error.statusCode === 404 : (error as { name?: string }).name === 'NotFoundHttpError');
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function hostedPodRootFromOwner(ownerUrl: URL): URL | undefined {
  if (ownerUrl.hash !== '#me') {
    return undefined;
  }
  if (!ownerUrl.pathname.endsWith('/profile/card')) {
    return undefined;
  }
  const podPath = ownerUrl.pathname.slice(0, -'profile/card'.length);
  if (!podPath || !podPath.endsWith('/')) {
    return undefined;
  }
  return new URL(podPath, ownerUrl.origin);
}

function podRootFromIntent(intent: GatewayAdminProxyIntent): URL | undefined {
  if (!intent.podBaseUrl) {
    try {
      return hostedPodRootFromOwner(new URL(intent.ownerWebId));
    } catch {
      return undefined;
    }
  }
  try {
    const root = new URL(intent.podBaseUrl);
    root.search = '';
    root.hash = '';
    root.pathname = ensureTrailingSlash(root.pathname);
    return root;
  } catch {
    return undefined;
  }
}

function resourceOwnerWebId(intent: GatewayAdminProxyIntent): string {
  const podRoot = podRootFromIntent(intent);
  return podRoot ? new URL('profile/card#me', podRoot).href : intent.ownerWebId;
}

function resourceReadPreferences(intent: GatewayAdminProxyIntent): { type: Record<string, number> } {
  return isGatewayAccessKeySecretResource(intent)
    ? { type: { 'application/json': 1, '*/*': 0.1 } }
    : { type: { 'text/turtle': 1, '*/*': 0.1 } };
}

function isGatewayAccessKeySecretResource(intent: GatewayAdminProxyIntent): boolean {
  try {
    const resource = new URL(intent.resourceUrl);
    const expected = new URL(resolveGatewayAccessKeySecretResourceUrl(resourceOwnerWebId(intent)));
    return resource.href === expected.href;
  } catch {
    return false;
  }
}

interface TrustedSparqlOperation {
  kind: 'query' | 'update';
  sparql: string;
  bodyDigest?: string;
}

async function trustedSparqlOperationForRequest(
  request: HttpRequest,
  ownerWebId: string,
  resourceUrl: URL,
  method: InternalPodDataMethod,
): Promise<TrustedSparqlOperation | undefined> {
  const queryFromUrl = trustedSparqlQueryForOwner(ownerWebId, resourceUrl);
  if (queryFromUrl !== undefined) {
    return method === 'GET' ? { kind: 'query', sparql: queryFromUrl } : undefined;
  }
  const endpointKind = trustedSparqlEndpointKind(ownerWebId, resourceUrl);
  if (method !== 'POST' || !endpointKind || resourceUrl.search || resourceUrl.hash) {
    return undefined;
  }
  const body = await readRequestBody(request);
  if (!body) {
    return undefined;
  }
  const contentType = firstHeader(request.headers['content-type'])?.split(';', 1)[0].trim().toLowerCase();
  let declaredKind: TrustedSparqlOperation['kind'] | undefined;
  let sparql: string | undefined;
  if (contentType === 'application/sparql-query') {
    declaredKind = 'query';
    sparql = body.toString('utf8').trim();
  } else if (contentType === 'application/sparql-update') {
    declaredKind = 'update';
    sparql = body.toString('utf8').trim();
  } else if (contentType === 'application/x-www-form-urlencoded') {
    const params = new URLSearchParams(body.toString('utf8'));
    const keys = Array.from(params.keys());
    const operation = keys.length === 1 && (keys[0] === 'query' || keys[0] === 'update')
      ? keys[0]
      : undefined;
    if (operation) {
      declaredKind = operation;
      sparql = params.get(operation)?.trim();
    }
  }
  const parsedKind = sparql ? parseSparqlKind(sparql) : undefined;
  if (!declaredKind || !sparql || parsedKind !== declaredKind ||
    (endpointKind !== 'settings' && parsedKind !== 'query')) {
    return undefined;
  }
  return {
    kind: parsedKind,
    sparql,
    bodyDigest: createHash('sha256').update(body).digest('hex'),
  };
}

function trustedSparqlQueryForOwner(ownerWebId: string, resourceUrl: URL): string | undefined {
  if (!trustedSparqlEndpointKind(ownerWebId, resourceUrl) || resourceUrl.hash) {
    return undefined;
  }
  const keys = Array.from(resourceUrl.searchParams.keys());
  if (keys.length !== 1 || keys[0] !== 'query') {
    return undefined;
  }
  const query = resourceUrl.searchParams.get('query')?.trim();
  return query && parseSparqlKind(query) === 'query' ? query : undefined;
}

function trustedSparqlEndpointKind(
  ownerWebId: string,
  resourceUrlValue: URL | string,
): 'models' | 'settings' | 'gatewayAccessKeys' | undefined {
  let ownerUrl: URL;
  let resourceUrl: URL;
  try {
    ownerUrl = new URL(ownerWebId);
    resourceUrl = typeof resourceUrlValue === 'string' ? new URL(resourceUrlValue) : resourceUrlValue;
  } catch {
    return undefined;
  }
  const podRoot = hostedPodRootFromOwner(ownerUrl);
  if (!podRoot || resourceUrl.origin !== podRoot.origin) {
    return undefined;
  }
  if (resourceUrl.pathname === `${podRoot.pathname}settings/providers/-/sparql`) {
    return 'models';
  }
  if (isGatewayAccessKeySparqlEndpoint(ownerWebId, resourceUrl)) {
    return 'gatewayAccessKeys';
  }
  return resourceUrl.pathname === `${podRoot.pathname}settings/-/sparql` ? 'settings' : undefined;
}

function isAllowedGatewayKeyVerifierResource(
  intent: GatewayAdminProxyIntent,
  resourceUrl: URL,
): boolean {
  const ownerWebId = resourceOwnerWebId(intent);
  let documentUrl: URL;
  try {
    documentUrl = new URL(resolveGatewayAccessKeyResourceUrl(ownerWebId));
  } catch {
    return false;
  }

  const exactDocument = resourceUrl.href === documentUrl.href;
  if (intent.scopes[0] === 'ai:gateway-key:touch') {
    return exactDocument && (intent.method === 'GET' || intent.method === 'HEAD' || intent.method === 'PATCH');
  }
  if (intent.scopes[0] !== 'ai:gateway-key:verify') {
    return false;
  }
  if (exactDocument) {
    return intent.method === 'GET' || intent.method === 'HEAD';
  }
  if (!isGatewayAccessKeySparqlEndpoint(ownerWebId, resourceUrl)) {
    return false;
  }
  if (intent.method === 'GET') {
    return trustedSparqlQueryForOwner(ownerWebId, resourceUrl) !== undefined;
  }
  return intent.method === 'POST' && !resourceUrl.search && !resourceUrl.hash;
}

function parseSparqlKind(value: string): TrustedSparqlOperation['kind'] | undefined {
  try {
    const parsed = new Parser({ baseIRI: 'urn:xpod:internal-sparql:' }).parse(value);
    return parsed.type === 'update' ? 'update' : parsed.type === 'query' ? 'query' : undefined;
  } catch {
    return undefined;
  }
}

function intentHasScope(
  intent: GatewayAdminProxyIntent,
  requiredScope: 'ai:credentials:read' | 'ai:credentials:write',
): boolean {
  return intent.scopes.some((scope) =>
    scope === requiredScope || scope === 'ai:credentials:*' || scope === 'ai:*',
  );
}

function intentAllowsSparqlOperation(
  intent: GatewayAdminProxyIntent,
  operation: TrustedSparqlOperation['kind'],
): boolean {
  if (intent.principalKind === 'gateway-key-verifier') {
    return operation === 'query'
      && intent.scopes.length === 1
      && intent.scopes[0] === 'ai:gateway-key:verify';
  }
  return intentHasScope(
    intent,
    operation === 'query' ? 'ai:credentials:read' : 'ai:credentials:write',
  );
}

async function readRequestBody(request: HttpRequest): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as unknown as AsyncIterable<Buffer | string>) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MODEL_QUERY_MAX_BODY_BYTES) {
      return undefined;
    }
    chunks.push(buffer);
  }
  if (size === 0) {
    return undefined;
  }
  return Buffer.concat(chunks, size);
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

class BoundedTtlNonceCache {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, number>();

  public constructor(options: { ttlMs: number; maxEntries: number; now?: () => number }) {
    this.ttlMs = Math.max(1, options.ttlMs);
    this.maxEntries = Math.max(1, options.maxEntries);
    this.now = options.now ?? Date.now;
  }

  public consume(nonce: string): boolean {
    const now = this.now();
    this.pruneExpired(now);
    if (this.entries.has(nonce)) {
      return false;
    }
    if (this.entries.size >= this.maxEntries) {
      return false;
    }
    this.entries.set(nonce, now + this.ttlMs);
    return true;
  }

  private pruneExpired(now: number): void {
    for (const [nonce, expiresAt] of this.entries) {
      if (expiresAt > now) {
        continue;
      }
      this.entries.delete(nonce);
    }
  }

}
