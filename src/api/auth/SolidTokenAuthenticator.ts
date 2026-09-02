import type { IncomingMessage } from 'node:http';
import { createSolidTokenVerifier } from '@solid/access-token-verifier';
import { getLoggerFor } from 'global-logger-factory';
import { createRoutedSolidTokenCaches } from '../../authentication/SolidTokenCaches';
import type { Authenticator, AuthResult } from './Authenticator';
import type { SolidAuthContext } from './AuthContext';
import {
  configuredHttpLoopbackOrigin,
  createConfiguredLoopbackSolidTokenVerifier,
} from './ConfiguredLoopbackSolidTokenVerifier';

const SOLID_LOCAL_ROUTE_CANONICAL_URL_HEADER = 'x-xpod-canonical-url';
const SOLID_LOCAL_ROUTE_LOCAL_URL_HEADER = 'x-xpod-local-route-url';

export interface SolidTokenAuthenticatorOptions {
  /**
   * Function to resolve accountId from webId (optional)
   */
  resolveAccountId?: (webId: string) => Promise<string | undefined>;
  publicBaseUrl?: string;
  internalBaseUrl?: string;
}

/**
 * Authenticator for Solid access tokens (Bearer or DPoP).
 */
export class SolidTokenAuthenticator implements Authenticator {
  private readonly logger = getLoggerFor(this);
  private readonly verify: ReturnType<typeof createSolidTokenVerifier>;
  private readonly resolveAccountId?: (webId: string) => Promise<string | undefined>;
  private readonly publicOrigin?: string;

  public constructor(options: SolidTokenAuthenticatorOptions = {}) {
    this.resolveAccountId = options.resolveAccountId;
    const { issuerKeySetCache, webIdIssuersCache, publicOrigin } = createRoutedSolidTokenCaches(options);
    this.publicOrigin = publicOrigin;
    const loopbackOrigin = configuredHttpLoopbackOrigin(publicOrigin);
    this.verify = loopbackOrigin
      ? createConfiguredLoopbackSolidTokenVerifier({
        allowedHttpOrigin: loopbackOrigin,
        getIssuers: webIdIssuersCache.getIssuers.bind(webIdIssuersCache),
        getKeySet: issuerKeySetCache.getKeySet.bind(issuerKeySetCache),
      })
      : createSolidTokenVerifier(undefined, issuerKeySetCache, webIdIssuersCache);
  }

  public canAuthenticate(request: IncomingMessage): boolean {
    const auth = request.headers.authorization;
    if (!auth) {
      return false;
    }
    const [scheme, token] = auth.split(' ');
    if (!scheme || !token) {
      return false;
    }
    if (scheme !== 'Bearer' && scheme !== 'DPoP') {
      return false;
    }
    return this.isJwt(token.trim());
  }

  public async authenticate(request: IncomingMessage): Promise<AuthResult> {
    const authorization = request.headers.authorization;
    if (!authorization) {
      return { success: false, error: 'Missing Authorization header' };
    }

    const [scheme, rawToken] = authorization.split(' ');
    const dpopRaw = request.headers.dpop;
    const dpopHeader = Array.isArray(dpopRaw) ? dpopRaw[0] : dpopRaw;
    if (scheme === 'DPoP' && !dpopHeader) {
      return { success: false, error: 'Missing DPoP header' };
    }

    try {
      // Build the request URL for verification
      const method = (request.method ?? 'GET') as 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';
      const url = this.buildRequestUrl(request);
      const payload = await this.verifyRequest(authorization, dpopHeader, method, url, request);

      const webId = this.extractWebId(payload);
      if (!webId) {
        return { success: false, error: 'Token missing webId claim' };
      }

      const clientId = this.extractString(payload, 'client_id') ?? 
                       this.extractString(payload, 'azp');

      let accountId: string | undefined;
      if (this.resolveAccountId) {
        try {
          accountId = await this.resolveAccountId(webId);
        } catch (error) {
          this.logger.warn(`Failed to resolve accountId for webId ${webId}: ${error}`);
        }
      }

      const context: SolidAuthContext = {
        type: 'solid',
        webId,
        accountId,
        clientId,
        accessToken: rawToken?.trim(),
        tokenType: scheme === 'DPoP' ? 'DPoP' : 'Bearer',
        dpopProof: dpopHeader?.trim(),
      };

      this.logger.debug(`Authenticated Solid token for webId: ${webId}`);
      return { success: true, context };
    } catch (error) {
      this.logger.warn(`Solid token verification failed: ${error}`);
      return { success: false, error: 'Invalid Solid token' };
    }
  }

  private buildRequestUrl(request: IncomingMessage): string {
    const canonicalUrl = this.trustedCanonicalRouteUrl(request);
    if (canonicalUrl) {
      return canonicalUrl;
    }
    const host = this.getHost(request);
    const proto = this.getProtocol(request);
    const prefix = this.getForwardedPrefix(request);
    const path = request.url ?? '/';
    const fullPath = prefix ? this.joinPaths(prefix, path) : path;
    return `${proto}://${host}${fullPath}`;
  }

  private async verifyRequest(
    authorization: string,
    dpopHeader: string | undefined,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS',
    url: string,
    request: IncomingMessage,
  ): Promise<Record<string, unknown>> {
    const dpopOptions = dpopHeader ? {
      header: dpopHeader,
      method,
      url,
    } : undefined;

    try {
      return await this.verify(authorization, dpopOptions) as unknown as Record<string, unknown>;
    } catch (error) {
      if (!dpopHeader) {
        throw error;
      }
      const configuredCanonicalUrl = this.configuredCanonicalRequestUrl(request, url);
      if (!configuredCanonicalUrl) {
        throw error;
      }
      return await this.verify(authorization, {
        header: dpopHeader,
        method,
        url: configuredCanonicalUrl,
      }) as unknown as Record<string, unknown>;
    }
  }

  private trustedCanonicalRouteUrl(request: IncomingMessage): string | undefined {
    if (!this.publicOrigin) {
      return undefined;
    }
    const canonicalRaw = this.firstHeaderValue(request.headers[SOLID_LOCAL_ROUTE_CANONICAL_URL_HEADER]);
    const localRaw = this.firstHeaderValue(request.headers[SOLID_LOCAL_ROUTE_LOCAL_URL_HEADER]);
    if (!canonicalRaw || !localRaw) {
      return undefined;
    }

    let canonicalUrl: URL;
    let localUrl: URL;
    try {
      canonicalUrl = new URL(canonicalRaw);
      localUrl = new URL(localRaw);
    } catch {
      return undefined;
    }
    if (canonicalUrl.origin !== this.publicOrigin) {
      return undefined;
    }

    const requestPath = this.pathAndSearch(request.url ?? '/');
    if (!requestPath) {
      return undefined;
    }
    if (this.pathAndSearch(canonicalUrl.href) !== requestPath) {
      return undefined;
    }
    if (this.pathAndSearch(localUrl.href) !== requestPath) {
      return undefined;
    }
    return canonicalUrl.href;
  }

  private configuredCanonicalRequestUrl(request: IncomingMessage, primaryUrl: string): string | undefined {
    if (!this.publicOrigin || this.hasLocalRouteHeader(request)) {
      return undefined;
    }
    const publicUrl = new URL(this.publicOrigin);
    if (publicUrl.protocol !== 'https:') {
      return undefined;
    }
    const requestPath = this.pathAndSearch(request.url ?? '/');
    if (!requestPath) {
      return undefined;
    }
    const configuredUrl = new URL(requestPath, this.publicOrigin).href;
    return configuredUrl === primaryUrl ? undefined : configuredUrl;
  }

  private hasLocalRouteHeader(request: IncomingMessage): boolean {
    return this.firstHeaderValue(request.headers[SOLID_LOCAL_ROUTE_CANONICAL_URL_HEADER]) !== undefined ||
      this.firstHeaderValue(request.headers[SOLID_LOCAL_ROUTE_LOCAL_URL_HEADER]) !== undefined;
  }

  private firstHeaderValue(value: string | string[] | undefined): string | undefined {
    const raw = Array.isArray(value) ? value[0] : value;
    return raw?.split(',')[0]?.trim() || undefined;
  }

  private pathAndSearch(value: string): string | undefined {
    try {
      const url = new URL(value, 'http://xpod.local');
      return `${url.pathname}${url.search}`;
    } catch {
      return undefined;
    }
  }

  private getProtocol(request: IncomingMessage): string {
    const forwarded = request.headers['x-forwarded-proto'];
    if (forwarded) {
      const proto = Array.isArray(forwarded) ? forwarded[0] : forwarded;
      return proto?.split(',')[0]?.trim() ?? 'http';
    }
    // Default to http for local development
    return 'http';
  }

  private getHost(request: IncomingMessage): string {
    const forwarded = request.headers['x-forwarded-host'];
    if (forwarded) {
      const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
      const host = raw?.split(',')[0]?.trim();
      if (host) {
        return host;
      }
    }
    return request.headers.host ?? 'localhost';
  }

  private getForwardedPrefix(request: IncomingMessage): string | undefined {
    const forwarded = request.headers['x-forwarded-prefix'];
    if (!forwarded) {
      return undefined;
    }
    const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    const prefix = raw?.split(',')[0]?.trim();
    return prefix && prefix !== '/' ? prefix : undefined;
  }

  private joinPaths(prefix: string, path: string): string {
    const normalizedPrefix = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    if (!normalizedPrefix) {
      return normalizedPath;
    }
    return `${normalizedPrefix}${normalizedPath}`;
  }

  private isJwt(token: string): boolean {
    return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token);
  }

  private extractWebId(payload: Record<string, unknown>): string | undefined {
    return this.extractString(payload, 'webid') ??
           this.extractString(payload, 'webId') ??
           this.extractString(payload, 'sub');
  }

  private extractString(obj: Record<string, unknown>, key: string): string | undefined {
    const value = obj[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
    return undefined;
  }
}
