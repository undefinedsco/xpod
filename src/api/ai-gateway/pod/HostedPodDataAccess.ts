import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { Parser } from 'sparqljs';
import {
  createAiConnectionsServiceAccess,
  isGatewayAccessKeySparqlEndpoint,
} from '../service-access/AiConnectionsServiceAccess';
import { createAiConfigResourceUrls } from '../service-access/AiConfigServiceAccess';
import type { AuthContext, SolidAuthContext } from '../../auth/AuthContext';
import {
  createGatewayAdminProxyHeaders,
  GATEWAY_ADMIN_PROXY_HEADERS,
  type GatewayAdminProxyIntent,
} from '../../../runtime/GatewayAdminProxyAuth';

export interface InternalPodAccessTokenProvider {
  getTrustedFetch(
    owner: string,
    auth?: InternalPodAccessAuthContext,
    context?: InternalPodAccessRequestContext,
  ): Promise<typeof fetch | undefined>;
}

export type InternalPodAccessAuthContext = AuthContext | undefined;

export interface InternalPodAccessRequestContext {
  /** Opaque label recorded for internal Pod access; no longer grants implicit authorization. */
  reason?: string;
  /** Physical Pod root when the identity WebID is hosted by a separate IdP. */
  podBaseUrl?: string;
}

export interface HostedPodDataAccessOptions {
  cssBaseUrl: string;
  gatewayAdminProxyAuthSecret?: string;
  fetch?: typeof fetch;
  now?: () => number;
  nonce?: () => string;
}

type InternalPodDataMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

const MODEL_QUERY_MAX_BODY_BYTES = 256 * 1024;
export const HOSTED_POD_RAW_BODY_MAX_BYTES = 1024 * 1024;

const INTERNAL_POD_DATA_PATH = '/.internal/pod-data';
const STRIPPED_CALLER_HEADERS = new Set([
  'authorization',
  // The request body is buffered before signing and forwarding. Let fetch
  // calculate the length for the forwarded bytes instead of retaining the
  // caller's stream-oriented header.
  'content-length',
  'dpop',
  'cookie',
]);

export class HostedPodDataAccess implements InternalPodAccessTokenProvider {
  private readonly cssBaseUrl: URL;
  private readonly gatewayAdminProxyAuthSecret?: string;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private readonly nonce: () => string;

  public constructor(options: HostedPodDataAccessOptions) {
    this.cssBaseUrl = new URL(options.cssBaseUrl);
    if (!isLoopbackHostname(this.cssBaseUrl.hostname)) {
      throw new Error('hosted_pod_css_loopback_required');
    }
    this.gatewayAdminProxyAuthSecret = options.gatewayAdminProxyAuthSecret ?? process.env.XPOD_GATEWAY_ADMIN_PROXY_AUTH_SECRET;
    this.fetch = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.nonce = options.nonce ?? randomUUID;
  }

  public async getTrustedFetch(
    owner: string,
    auth?: InternalPodAccessAuthContext,
    context?: InternalPodAccessRequestContext,
  ): Promise<typeof fetch | undefined> {
    return async (input, init) => {
      const request = new Request(input, init);
      const method = normalizeMethod(request.method);
      const resourceUrl = normalizeResourceUrl(request.url);
      const body = method === 'POST' ? await readRequestBody(request) : undefined;
      const forwardedBytes = method === 'PATCH' || method === 'PUT'
        ? await readRequestBytes(request)
        : undefined;
      const authorization = this.authorize({ owner, auth, context, method, resourceUrl, body });
      const loopbackUrl = new URL(INTERNAL_POD_DATA_PATH, this.cssBaseUrl);
      const headers = this.headersForLoopback(request.headers, {
        ownerWebId: owner,
        ...(context?.podBaseUrl ? { podBaseUrl: context.podBaseUrl } : {}),
        method,
        resourceUrl,
        principalKind: authorization.principalKind,
        scopes: authorization.scopes,
        ...(body ? { bodyDigest: body.digest } : {}),
      });
      const forwardedBody = method === 'POST'
        ? body?.bytes
        : forwardedBytes ?? request.body;

      try {
        return await this.fetch(loopbackUrl, {
          method,
          headers,
          body: forwardedBody,
          signal: init?.signal ?? request.signal,
          ...(forwardedBody instanceof ReadableStream ? { duplex: 'half' } : {}),
        } as RequestInit);
      } catch (error) {
        const message = error instanceof Error
          ? `${error.message}${error.cause ? `:${String(error.cause)}` : ''}`
          : String(error);
        throw new Error(`hosted_pod_loopback_fetch_failed:${loopbackUrl.href}:${message}`, { cause: error });
      }
    };
  }

  private authorize(input: {
    owner: string;
    auth?: InternalPodAccessAuthContext;
    context?: InternalPodAccessRequestContext;
    method: InternalPodDataMethod;
    resourceUrl: string;
    body?: RequestBody;
  }): Pick<GatewayAdminProxyIntent, 'principalKind' | 'scopes'> {
    this.assertHostedAllowedResource(
      input.owner,
      input.resourceUrl,
      input.method,
      input.body,
      input.context?.podBaseUrl,
    );

    if (!input.auth && input.context?.reason === 'gateway-key-verifier') {
      return {
        principalKind: 'gateway-key-verifier',
        scopes: [input.method === 'PATCH' ? 'ai:gateway-key:touch' : 'ai:gateway-key:verify'],
      };
    }

    if (!input.auth) {
      throw new Error('hosted_pod_auth_required');
    }
    if (input.auth.type !== 'solid') {
      throw new Error('hosted_pod_solid_principal_required');
    }
    if (input.auth.webId !== input.owner) {
      throw new Error('hosted_pod_owner_mismatch');
    }
    return {
      principalKind: 'solid-user',
      scopes: [isReadOnlyMethod(
        input.method,
        input.resourceUrl,
        input.owner,
        input.body,
        input.context?.podBaseUrl,
      )
        ? 'ai:credentials:read'
        : 'ai:credentials:write'],
    };
  }

  private assertHostedAllowedResource(
    owner: string,
    resourceUrl: string,
    method: InternalPodDataMethod,
    body?: RequestBody,
    podBaseUrl?: string,
  ): void {
    const resource = parseUrl(resourceUrl, 'hosted_pod_resource_url_invalid');
    const ownerUrl = parseUrl(owner, 'hosted_pod_owner_url_invalid');
    const podRoot = podBaseUrl
      ? normalizePodRoot(podBaseUrl)
      : hostedPodRootFromOwner(ownerUrl);
    if (!podRoot || resource.origin !== podRoot.origin || !resource.pathname.startsWith(podRoot.pathname)) {
      throw new Error('hosted_pod_remote_resource');
    }
    const modelCollectionPath = `${podRoot.pathname}settings/providers/-/sparql`;
    const settingsCollectionPath = `${podRoot.pathname}settings/-/sparql`;
    const storageOwner = new URL('profile/card#me', podRoot).href;
    const gatewayAccessKeyEndpoint = isGatewayAccessKeySparqlEndpoint(storageOwner, resource);
    if (resource.pathname === modelCollectionPath || resource.pathname === settingsCollectionPath || gatewayAccessKeyEndpoint) {
      const queryOnlyEndpoint = resource.pathname === modelCollectionPath || gatewayAccessKeyEndpoint;
      if (resource.hash || (method === 'GET' && !hasExactlyOneSparqlQuery(resource)) ||
        (method === 'POST' && (resource.search || !body)) ||
        (queryOnlyEndpoint && method === 'POST' && body?.kind !== 'query')) {
        throw new Error('hosted_pod_resource_not_allowed');
      }
      if (method !== 'GET' && method !== 'POST') {
        throw new Error('hosted_pod_resource_not_allowed');
      }
      return;
    }
    if (resource.hash || resource.search) {
      throw new Error('hosted_pod_resource_not_allowed');
    }

    const allowed = createAiConnectionsServiceAccess({
      ownerWebId: storageOwner,
      serviceWebId: owner,
    }).resources.map((entry) => entry.url);
    allowed.push(...createAiConfigResourceUrls(storageOwner));
    if (!allowed.includes(resource.href)) {
      throw new Error('hosted_pod_resource_not_allowed');
    }
  }

  private headersForLoopback(headers: Headers, intent: GatewayAdminProxyIntent): Headers {
    const next = new Headers();
    headers.forEach((value, key) => {
      const normalized = key.toLowerCase();
      if (
        STRIPPED_CALLER_HEADERS.has(normalized)
        || GATEWAY_ADMIN_PROXY_HEADERS.includes(normalized as typeof GATEWAY_ADMIN_PROXY_HEADERS[number])
        || normalized.startsWith('x-xpod-admin-proxy-')
      ) {
        return;
      }
      next.set(key, value);
    });

    if (!this.gatewayAdminProxyAuthSecret) {
      throw new Error('XPOD_GATEWAY_ADMIN_PROXY_AUTH_SECRET is required for hosted Pod data access');
    }
    const marker = createGatewayAdminProxyHeaders({
      secret: this.gatewayAdminProxyAuthSecret,
      method: intent.method,
      url: INTERNAL_POD_DATA_PATH,
      originalClientLoopback: true,
      issuedAt: this.now(),
      nonce: this.nonce(),
      intent,
    });
    for (const [key, value] of Object.entries(marker)) {
      if (value !== undefined) {
        next.set(key, Array.isArray(value) ? value.join(', ') : String(value));
      }
    }
    return next;
  }
}

function normalizePodRoot(value: string): URL {
  const root = new URL(value);
  root.search = '';
  root.hash = '';
  if (!root.pathname.endsWith('/')) root.pathname += '/';
  return root;
}

function hasExactlyOneSparqlQuery(resource: URL): boolean {
  const keys = Array.from(resource.searchParams.keys());
  const query = resource.searchParams.get('query')?.trim();
  return keys.length === 1 && keys[0] === 'query' && query !== undefined && sparqlKind(query) === 'query';
}

function normalizeMethod(method: string | undefined): InternalPodDataMethod {
  const upper = (method ?? 'GET').toUpperCase();
  if (upper === 'GET' || upper === 'HEAD' || upper === 'POST' || upper === 'PUT' || upper === 'PATCH' || upper === 'DELETE') {
    return upper;
  }
  throw new Error('hosted_pod_method_not_allowed');
}

interface RequestBody {
  kind: 'query' | 'update';
  sparql: string;
  digest: string;
  bytes: Uint8Array;
}

async function readRequestBytes(
  request: Request,
  maxBytes = HOSTED_POD_RAW_BODY_MAX_BYTES,
): Promise<Uint8Array | undefined> {
  const body = request.body;
  if (!body) {
    return undefined;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      if (chunk.byteLength > maxBytes - totalBytes) {
        try {
          await reader.cancel();
        } catch {
          // Preserve the stable size error even if the source cannot cancel cleanly.
        }
        throw new Error('hosted_pod_body_too_large');
      }
      chunks.push(chunk);
      totalBytes += chunk.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function readRequestBody(request: Request): Promise<RequestBody | undefined> {
  const bytes = await readRequestBytes(request, MODEL_QUERY_MAX_BODY_BYTES);
  if (!bytes) {
    return undefined;
  }
  if (bytes.byteLength === 0) {
    return undefined;
  }
  const contentType = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  let declaredKind: RequestBody['kind'] | undefined;
  let sparql: string | undefined;
  if (contentType === 'application/sparql-query') {
    declaredKind = 'query';
    sparql = new TextDecoder().decode(bytes).trim();
  } else if (contentType === 'application/sparql-update') {
    declaredKind = 'update';
    sparql = new TextDecoder().decode(bytes).trim();
  } else if (contentType === 'application/x-www-form-urlencoded') {
    const params = new URLSearchParams(new TextDecoder().decode(bytes));
    const keys = Array.from(params.keys());
    const operation = keys.length === 1 && (keys[0] === 'query' || keys[0] === 'update')
      ? keys[0]
      : undefined;
    if (operation) {
      declaredKind = operation;
      sparql = params.get(operation)?.trim();
    }
  }
  if (!declaredKind || !sparql || sparqlKind(sparql) !== declaredKind) {
    return undefined;
  }
  return {
    kind: declaredKind,
    sparql,
    digest: createHash('sha256').update(bytes).digest('hex'),
    bytes,
  };
}

function sparqlKind(value: string): RequestBody['kind'] | undefined {
  try {
    const parsed = new Parser({ baseIRI: 'urn:xpod:internal-sparql:' }).parse(value);
    return parsed.type === 'update' ? 'update' : parsed.type === 'query' ? 'query' : undefined;
  } catch {
    return undefined;
  }
}

function isReadOnlyMethod(
  method: InternalPodDataMethod,
  resourceUrl: string,
  ownerWebId: string,
  body?: RequestBody,
  podBaseUrl?: string,
): boolean {
  if (method === 'GET' || method === 'HEAD') {
    return true;
  }
  if (method !== 'POST') {
    return false;
  }
  try {
    const resource = new URL(resourceUrl);
    const podRoot = podBaseUrl
      ? normalizePodRoot(podBaseUrl)
      : hostedPodRootFromOwner(new URL(ownerWebId));
    if (!podRoot || body?.kind !== 'query') {
      return false;
    }
    const storageOwnerWebId = new URL('profile/card#me', podRoot).href;
    return resource.pathname === `${podRoot.pathname}settings/providers/-/sparql`
      || resource.pathname === `${podRoot.pathname}settings/-/sparql`
      || isGatewayAccessKeySparqlEndpoint(storageOwnerWebId, resource);
  } catch {
    return false;
  }
}

function normalizeResourceUrl(value: string): string {
  return new URL(value).href;
}

function parseUrl(value: string, errorCode: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new Error(errorCode);
  }
}

function hostedPodRootFromOwner(ownerUrl: URL): URL | undefined {
  if (ownerUrl.hash !== '#me' || !ownerUrl.pathname.endsWith('/profile/card')) {
    return undefined;
  }
  const podPath = ownerUrl.pathname.slice(0, -'profile/card'.length);
  if (!podPath || !podPath.endsWith('/')) {
    return undefined;
  }
  return new URL(podPath, ownerUrl.origin);
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/gu, '').toLowerCase();
  if (normalized === 'localhost') {
    return true;
  }
  if (isIP(normalized) === 4) {
    return normalized.startsWith('127.');
  }
  return normalized === '::1';
}
