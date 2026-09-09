import { IssuerKeySetCache } from '@solid/access-token-verifier/dist/class/IssuerKeySetCache';
import { WebIDIssuersCache } from '@solid/access-token-verifier/dist/class/WebIDIssuersCache';
import { createLocalJWKSet, createRemoteJWKSet, type JSONWebKeySet } from 'jose';
import { DataFactory, Parser, Store } from 'n3';

const SOLID_OIDC_ISSUER = DataFactory.namedNode('http://www.w3.org/ns/solid/terms#oidcIssuer');
const WEB_ID_DEREFERENCE_RETRY_DELAYS_MS = [ 0, 200, 500 ] as const;

export interface SolidTokenCacheRouting {
  publicBaseUrl?: string;
  internalBaseUrl?: string;
}

export function createRoutedSolidTokenCaches(options: SolidTokenCacheRouting = {}): {
  issuerKeySetCache: IssuerKeySetCache;
  webIdIssuersCache: WebIDIssuersCache;
  publicOrigin?: string;
} {
  const publicOrigin = options.publicBaseUrl ? new URL(options.publicBaseUrl).origin : undefined;
  const internalOrigin = options.internalBaseUrl ? new URL(options.internalBaseUrl).origin : undefined;
  return {
    issuerKeySetCache: new FetchIssuerKeySetCache(publicOrigin, internalOrigin),
    webIdIssuersCache: new FetchWebIdIssuersCache(publicOrigin, internalOrigin),
    publicOrigin,
  };
}

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

    const response = await this.fetchProfile(webId);
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

  private async fetchProfile(webId: string): Promise<Response> {
    const target = this.internalUrl(webId);
    let response: Response | undefined;
    for (const delayMs of WEB_ID_DEREFERENCE_RETRY_DELAYS_MS) {
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      response = await fetch(target, {
        headers: { Accept: 'text/turtle', ...this.forwardedHeaders(webId) },
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok || !this.isTransientBootstrapStatus(response.status)) {
        return response;
      }
    }
    if (!response) {
      throw new Error('WebID dereference was not attempted');
    }
    return response;
  }

  private isTransientBootstrapStatus(status: number): boolean {
    return status === 401 || status === 404 || status === 409 || status === 425 || status === 429 || status >= 500;
  }

  private internalUrl(value: string): string {
    const url = new URL(value);
    if (this.publicOrigin && this.internalOrigin && url.origin === this.publicOrigin) {
      return new URL(`${url.pathname}${url.search}`, this.internalOrigin).href;
    }
    return url.href;
  }

  /**
   * Keep the logical public host while reading through the internal CSS port,
   * otherwise CSS derives a loopback identifier instead of the canonical one.
   */
  private forwardedHeaders(value: string): Record<string, string> {
    if (this.publicOrigin && this.internalOrigin && new URL(value).origin === this.publicOrigin) {
      const logicalUrl = new URL(value);
      return {
        'X-Forwarded-Host': logicalUrl.host,
        'X-Forwarded-Proto': logicalUrl.protocol.slice(0, -1),
      };
    }
    return {};
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
    const configurationResponse = await fetch(this.internalUrl(logicalConfigurationUrl), {
      headers: { Accept: 'application/json', ...this.forwardedHeaders(logicalConfigurationUrl) },
      signal: AbortSignal.timeout(10_000),
    });
    if (!configurationResponse.ok) {
      throw new Error(`OIDC issuer configuration failed: HTTP ${configurationResponse.status}`);
    }
    const configuration = await configurationResponse.json() as { jwks_uri?: unknown };
    if (typeof configuration.jwks_uri !== 'string') {
      throw new Error('OIDC issuer configuration is missing jwks_uri');
    }
    const keySetResponse = await fetch(this.internalUrl(new URL(configuration.jwks_uri)), {
      headers: { Accept: 'application/json', ...this.forwardedHeaders(configuration.jwks_uri) },
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

  private forwardedHeaders(value: URL | string): Record<string, string> {
    const url = new URL(typeof value === 'string' ? value : value.href);
    if (this.publicOrigin && this.internalOrigin && url.origin === this.publicOrigin) {
      return {
        'X-Forwarded-Host': url.host,
        'X-Forwarded-Proto': url.protocol.slice(0, -1),
      };
    }
    return {};
  }
}
