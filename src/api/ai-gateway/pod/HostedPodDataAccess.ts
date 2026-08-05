import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { createAiConnectionServiceAccess } from '../service-access/AiConnectionServiceAccess';
import type { AuthContext, SolidAuthContext } from '../../auth/AuthContext';
import {
  createGatewayAdminProxyHeaders,
  GATEWAY_ADMIN_PROXY_HEADERS,
  type GatewayAdminProxyIntent,
} from '../../../runtime/GatewayAdminProxyAuth';

export interface InternalPodAccessTokenProvider {
  getTrustedFetch(owner: string, auth?: InternalPodAccessAuthContext): Promise<typeof fetch | undefined>;
}

export type InternalPodAccessAuthContext = AuthContext | undefined;

export interface HostedPodDataAccessOptions {
  cssBaseUrl: string;
  gatewayAdminProxyAuthSecret?: string;
  fetch?: typeof fetch;
  now?: () => number;
  nonce?: () => string;
}

type InternalPodDataMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

const MODEL_QUERY_MAX_BODY_BYTES = 256 * 1024;

const INTERNAL_POD_DATA_PATH = '/.internal/pod-data';
const STRIPPED_CALLER_HEADERS = new Set([
  'authorization',
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

  public async getTrustedFetch(owner: string, auth?: InternalPodAccessAuthContext): Promise<typeof fetch | undefined> {
    return async (input, init) => {
      const request = new Request(input, init);
      const method = normalizeMethod(request.method);
      const resourceUrl = normalizeResourceUrl(request.url);
      const body = method === 'POST' ? await readRequestBody(request) : undefined;
      const authorization = this.authorize({ owner, auth, method, resourceUrl, body });
      const loopbackUrl = new URL(INTERNAL_POD_DATA_PATH, this.cssBaseUrl);
      const headers = this.headersForLoopback(request.headers, {
        ownerWebId: owner,
        method,
        resourceUrl,
        principalKind: authorization.principalKind,
        scopes: [isReadOnlyMethod(method, resourceUrl, owner) ? 'ai:credentials:read' : 'ai:credentials:write'],
        ...(body ? { bodyDigest: body.digest } : {}),
      });
      const forwardedBody = method === 'POST' ? body?.bytes : request.body;

      return this.fetch(loopbackUrl, {
        method,
        headers,
        body: forwardedBody,
        signal: init?.signal ?? request.signal,
        ...(forwardedBody ? { duplex: 'half' } : {}),
      } as RequestInit);
    };
  }

  private authorize(input: {
    owner: string;
    auth?: InternalPodAccessAuthContext;
    method: InternalPodDataMethod;
    resourceUrl: string;
    body?: RequestBody;
  }): { principalKind: GatewayAdminProxyIntent['principalKind'] } {
    this.assertHostedAllowedResource(input.owner, input.resourceUrl, input.method, input.body);

    if (!input.auth) {
      throw new Error('hosted_pod_auth_required');
    }
    if (input.auth.type !== 'solid') {
      throw new Error('hosted_pod_solid_principal_required');
    }
    if (input.auth.webId !== input.owner) {
      throw new Error('hosted_pod_owner_mismatch');
    }
    return { principalKind: 'solid-user' };
  }

  private assertHostedAllowedResource(owner: string, resourceUrl: string, method: InternalPodDataMethod, body?: RequestBody): void {
    const resource = parseUrl(resourceUrl, 'hosted_pod_resource_url_invalid');
    const ownerUrl = parseUrl(owner, 'hosted_pod_owner_url_invalid');
    const podRoot = hostedPodRootFromOwner(ownerUrl);
    if (!podRoot || resource.origin !== podRoot.origin || !resource.pathname.startsWith(podRoot.pathname)) {
      throw new Error('hosted_pod_remote_resource');
    }
    const modelCollectionPath = `${podRoot.pathname}settings/providers/-/sparql`;
    if (resource.pathname === modelCollectionPath) {
      if (resource.hash || (method === 'GET' && !hasExactlyOneModelQuery(resource)) ||
        (method === 'POST' && (resource.search || !body?.query))) {
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

    const allowed = createAiConnectionServiceAccess({
      ownerWebId: owner,
      serviceWebId: owner,
    }).resources.map((entry) => entry.url);
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

function hasExactlyOneModelQuery(resource: URL): boolean {
  const keys = Array.from(resource.searchParams.keys());
  return keys.length === 1 && keys[0] === 'query' && resource.searchParams.get('query')?.trim().length !== 0;
}

function normalizeMethod(method: string | undefined): InternalPodDataMethod {
  const upper = (method ?? 'GET').toUpperCase();
  if (upper === 'GET' || upper === 'HEAD' || upper === 'POST' || upper === 'PUT' || upper === 'PATCH' || upper === 'DELETE') {
    return upper;
  }
  throw new Error('hosted_pod_method_not_allowed');
}

interface RequestBody {
  query: string;
  digest: string;
  bytes: Uint8Array;
}

async function readRequestBody(request: Request): Promise<RequestBody | undefined> {
  if (!request.body) {
    return undefined;
  }
  const bytes = new Uint8Array(await request.clone().arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > MODEL_QUERY_MAX_BODY_BYTES) {
    return undefined;
  }
  const contentType = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  let query: string | undefined;
  if (contentType === 'application/sparql-query') {
    query = new TextDecoder().decode(bytes).trim();
  } else if (contentType === 'application/x-www-form-urlencoded') {
    const params = new URLSearchParams(new TextDecoder().decode(bytes));
    const keys = Array.from(params.keys());
    if (keys.length === 1 && keys[0] === 'query') {
      query = params.get('query')?.trim();
    }
  }
  if (!query) {
    return undefined;
  }
  return {
    query,
    digest: createHash('sha256').update(bytes).digest('hex'),
    bytes,
  };
}

function isReadOnlyMethod(method: InternalPodDataMethod, resourceUrl: string, ownerWebId: string): boolean {
  if (method === 'GET' || method === 'HEAD') {
    return true;
  }
  if (method !== 'POST') {
    return false;
  }
  try {
    const resource = new URL(resourceUrl);
    const owner = new URL(ownerWebId);
    const rootPath = hostedPodRootFromOwner(owner)?.pathname;
    return rootPath !== undefined && resource.pathname === `${rootPath}settings/providers/-/sparql`;
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
