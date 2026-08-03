import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { createAiConnectionServiceAccess } from '../service-access/AiConnectionServiceAccess';
import type { AuthContext, SolidAuthContext } from '../../auth/AuthContext';
import type { InternalPodAccessTokenProvider } from '../auth/PodGatewayAccessKeyRepository';
import {
  createGatewayAdminProxyHeaders,
  GATEWAY_ADMIN_PROXY_HEADERS,
  type GatewayAdminProxyIntent,
} from '../../../runtime/GatewayAdminProxyAuth';

export interface HostedPodDataAccessOptions {
  cssBaseUrl: string;
  gatewayAdminProxyAuthSecret?: string;
  fetch?: typeof fetch;
  now?: () => number;
  nonce?: () => string;
}

type InternalPodDataMethod = 'GET' | 'PUT' | 'PATCH' | 'DELETE';

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

  public async getTrustedFetch(owner: string, auth?: AuthContext): Promise<typeof fetch | undefined> {
    return async (input, init) => {
      const request = new Request(input, init);
      const method = normalizeMethod(request.method);
      const resourceUrl = normalizeResourceUrl(request.url);
      const authorization = this.authorize({ owner, auth, method, resourceUrl });
      const loopbackUrl = new URL(INTERNAL_POD_DATA_PATH, this.cssBaseUrl);
      const headers = this.headersForLoopback(request.headers, {
        ownerWebId: owner,
        method,
        resourceUrl,
        principalKind: authorization.principalKind,
        scopes: [method === 'GET' ? 'ai:credentials:read' : 'ai:credentials:write'],
      });

      return this.fetch(loopbackUrl, {
        method,
        headers,
        body: request.body,
        signal: init?.signal ?? request.signal,
        ...(request.body ? { duplex: 'half' } : {}),
      } as RequestInit);
    };
  }

  private authorize(input: {
    owner: string;
    auth?: AuthContext;
    method: InternalPodDataMethod;
    resourceUrl: string;
  }): { principalKind: GatewayAdminProxyIntent['principalKind'] } {
    this.assertHostedAllowedResource(input.owner, input.resourceUrl);

    if (!input.auth) {
      throw new Error('hosted_pod_auth_required');
    }
    if (input.auth.type !== 'solid') {
      throw new Error('hosted_pod_solid_principal_required');
    }
    if (input.auth.webId !== input.owner) {
      throw new Error('hosted_pod_owner_mismatch');
    }
    if (input.auth.viaGatewayApiKey === true) {
      this.assertGatewayScope(input.auth, input.method);
      return { principalKind: 'gateway-key' };
    }
    return { principalKind: 'solid-user' };
  }

  private assertGatewayScope(auth: SolidAuthContext, method: InternalPodDataMethod): void {
    const required = method === 'GET' ? 'models:read' : 'inference:write';
    if (!auth.scopes?.includes(required)) {
      throw new Error(`gateway_scope_missing:${required}`);
    }
  }

  private assertHostedAllowedResource(owner: string, resourceUrl: string): void {
    const resource = parseUrl(resourceUrl, 'hosted_pod_resource_url_invalid');
    const ownerUrl = parseUrl(owner, 'hosted_pod_owner_url_invalid');
    const podRoot = hostedPodRootFromOwner(ownerUrl);
    if (!podRoot || resource.origin !== podRoot.origin || !resource.pathname.startsWith(podRoot.pathname)) {
      throw new Error('hosted_pod_remote_resource');
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

function normalizeMethod(method: string | undefined): InternalPodDataMethod {
  const upper = (method ?? 'GET').toUpperCase();
  if (upper === 'GET' || upper === 'PUT' || upper === 'PATCH' || upper === 'DELETE') {
    return upper;
  }
  throw new Error('hosted_pod_method_not_allowed');
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
