import type { IncomingMessage } from 'node:http';
import { createSolidTokenVerifier } from '@solid/access-token-verifier';
import { IssuerKeySetCache } from '@solid/access-token-verifier/dist/class/IssuerKeySetCache';
import { WebIDIssuersCache } from '@solid/access-token-verifier/dist/class/WebIDIssuersCache';
import { getLoggerFor } from 'global-logger-factory';
import { createLocalJWKSet, createRemoteJWKSet, type JSONWebKeySet } from 'jose';
import { DataFactory, Parser, Store } from 'n3';
import type { Authenticator, AuthResult } from './Authenticator';
import type { SolidAuthContext } from './AuthContext';

const SOLID_OIDC_ISSUER = DataFactory.namedNode('http://www.w3.org/ns/solid/terms#oidcIssuer');

class FetchWebIdIssuersCache extends WebIDIssuersCache {
  private readonly resolved = new Map<string, string[]>();

  public constructor(
    private readonly publicOrigin?: string,
    private readonly internalOrigin?: string,
  ) {
    super();
  }

  public override async getIssuers(webId: string): Promise<string[]> {
    const cached = this.resolved.get(webId);
    if (cached) {
      return cached;
    }

    const target = this.internalUrl(webId);
    const response = await fetch(target, {
      headers: { Accept: 'text/turtle' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`WebID dereference failed: HTTP ${response.status}`);
    }
    const baseIRI = response.url || webId;
    const store = new Store(new Parser({ baseIRI }).parse(await response.text()));
    const issuers = store
      .getObjects(DataFactory.namedNode(webId), SOLID_OIDC_ISSUER, null)
      .map((term) => term.value);
    this.resolved.set(webId, issuers);
    return issuers;
  }

  private internalUrl(value: string): string {
    const url = new URL(value);
    if (this.publicOrigin && this.internalOrigin && url.origin === this.publicOrigin) {
      return new URL(`${url.pathname}${url.search}`, this.internalOrigin).href;
    }
    return url.href;
  }
}

class FetchIssuerKeySetCache extends IssuerKeySetCache {
  private readonly resolved = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

  public constructor(
    private readonly publicOrigin?: string,
    private readonly internalOrigin?: string,
  ) {
    super();
  }

  public override async getKeySet(issuer: string): Promise<ReturnType<typeof createRemoteJWKSet>> {
    const cached = this.resolved.get(issuer);
    if (cached) {
      return cached;
    }

    const logicalConfigurationUrl = new URL(
      '.well-known/openid-configuration',
      issuer.endsWith('/') ? issuer : `${issuer}/`,
    );
    const configurationTarget = this.internalUrl(logicalConfigurationUrl);
    const configurationResponse = await fetch(configurationTarget, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!configurationResponse.ok) {
      throw new Error(`OIDC issuer configuration failed: HTTP ${configurationResponse.status}`);
    }
    const configuration = await configurationResponse.json() as { jwks_uri?: unknown };
    if (typeof configuration.jwks_uri !== 'string') {
      throw new Error('OIDC issuer configuration is missing jwks_uri');
    }
    const keySetTarget = this.internalUrl(new URL(configuration.jwks_uri));
    const keySetResponse = await fetch(keySetTarget, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!keySetResponse.ok) {
      throw new Error(`OIDC issuer JWKS failed: HTTP ${keySetResponse.status}`);
    }
    const keySet = createLocalJWKSet(
      await keySetResponse.json() as JSONWebKeySet,
    ) as unknown as ReturnType<typeof createRemoteJWKSet>;
    this.resolved.set(issuer, keySet);
    return keySet;
  }

  private internalUrl(url: URL): URL {
    if (this.publicOrigin && this.internalOrigin && url.origin === this.publicOrigin) {
      return new URL(`${url.pathname}${url.search}`, this.internalOrigin);
    }
    return url;
  }
}

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

  public constructor(options: SolidTokenAuthenticatorOptions = {}) {
    this.resolveAccountId = options.resolveAccountId;
    const publicOrigin = options.publicBaseUrl ? new URL(options.publicBaseUrl).origin : undefined;
    const internalOrigin = options.internalBaseUrl ? new URL(options.internalBaseUrl).origin : undefined;
    this.verify = createSolidTokenVerifier(
      undefined,
      new FetchIssuerKeySetCache(publicOrigin, internalOrigin),
      new FetchWebIdIssuersCache(publicOrigin, internalOrigin),
    );
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

      const dpopOptions = dpopHeader ? {
        header: dpopHeader,
        method,
        url,
      } : undefined;

      const payload = await this.verify(authorization, dpopOptions) as unknown as Record<string, unknown>;

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
    const host = this.getHost(request);
    const proto = this.getProtocol(request);
    const prefix = this.getForwardedPrefix(request);
    const path = request.url ?? '/';
    const fullPath = prefix ? this.joinPaths(prefix, path) : path;
    return `${proto}://${host}${fullPath}`;
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
