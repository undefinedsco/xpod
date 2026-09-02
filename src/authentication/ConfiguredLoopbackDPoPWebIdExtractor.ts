import { createSolidTokenVerifier } from '@solid/access-token-verifier';
import { REQUEST_METHOD } from '@solid/access-token-verifier/dist/constant/REQUEST_METHOD';
import type { DPoPOptions, SolidTokenVerifierFunction } from '@solid/access-token-verifier/dist/type';
import {
  BadRequestHttpError,
  CredentialsExtractor,
  NotImplementedHttpError,
  type Credentials,
  type HttpRequest,
  type TargetExtractor,
} from '@solid/community-server';
import { getLoggerFor } from 'global-logger-factory';
import {
  configuredHttpLoopbackOrigin,
  createConfiguredLoopbackSolidTokenVerifier,
} from '../api/auth/ConfiguredLoopbackSolidTokenVerifier';
import { verifyGatewayAdminProxyHeaders } from '../runtime/GatewayAdminProxyAuth';
import { createRoutedSolidTokenCaches } from './SolidTokenCaches';

const SOLID_LOCAL_ROUTE_CANONICAL_URL_HEADER = 'x-xpod-canonical-url';
const SOLID_LOCAL_ROUTE_LOCAL_URL_HEADER = 'x-xpod-local-route-url';

/**
 * CSS-compatible DPoP credential extractor that admits one configured HTTP
 * loopback IP origin without weakening any access-token or DPoP checks.
 *
 * HTTPS and localhost deployments keep using the upstream verifier unchanged.
 */
export class ConfiguredLoopbackDPoPWebIdExtractor extends CredentialsExtractor {
  private readonly verify: SolidTokenVerifierFunction;
  private readonly allowedHttpOrigin?: string;
  private readonly originalUrlExtractor: TargetExtractor;
  protected readonly logger = getLoggerFor(this);

  public constructor(originalUrlExtractor: TargetExtractor, baseUrl: string) {
    super();
    this.originalUrlExtractor = originalUrlExtractor;
    this.allowedHttpOrigin = configuredHttpLoopbackOrigin(baseUrl);
    const { issuerKeySetCache, webIdIssuersCache } = createRoutedSolidTokenCaches({
      publicBaseUrl: baseUrl,
      internalBaseUrl: deriveCssLoopbackBaseUrl(process.env.CSS_PORT),
    });

    if (this.allowedHttpOrigin) {
      this.verify = createConfiguredLoopbackSolidTokenVerifier({
        allowedHttpOrigin: this.allowedHttpOrigin,
        getIssuers: webIdIssuersCache.getIssuers.bind(webIdIssuersCache),
        getKeySet: issuerKeySetCache.getKeySet.bind(issuerKeySetCache),
      });
    } else {
      this.verify = createSolidTokenVerifier(undefined, issuerKeySetCache, webIdIssuersCache);
    }
  }

  public override async canHandle({ headers }: HttpRequest): Promise<void> {
    const { authorization } = headers;
    if (typeof authorization !== 'string' || !/^DPoP /iu.test(authorization)) {
      throw new NotImplementedHttpError('No DPoP-bound Authorization header specified.');
    }
  }

  public override async handle(request: HttpRequest): Promise<Credentials> {
    const { headers: { authorization, dpop }, method } = request;
    if (typeof authorization !== 'string') {
      throw new BadRequestHttpError('No DPoP-bound Authorization header specified.');
    }
    if (typeof dpop !== 'string') {
      throw new BadRequestHttpError('No DPoP header specified.');
    }
    if (!isDpopRequestMethod(method)) {
      throw new BadRequestHttpError('The request method is not supported by the DPoP verifier.');
    }

    const originalUrl = await this.originalUrlExtractor.handleSafe({ request });

    try {
      if (this.allowedHttpOrigin && new URL(originalUrl.path).origin !== this.allowedHttpOrigin) {
        const localRouteUrl = this.trustedLocalRouteUrl(request, originalUrl.path);
        if (!localRouteUrl || new URL(localRouteUrl).origin !== this.allowedHttpOrigin) {
          throw new Error('The DPoP request URL does not match the configured HTTP loopback origin.');
        }
      }

      const { webid: webId, client_id: clientId, iss: issuer } = await this.verifyWithLocalRouteFallback(request, authorization, {
        header: dpop,
        method,
        url: originalUrl.path,
      });
      this.logger.info(
        `Verified WebID via DPoP-bound access token. WebID: ${webId}, client ID: ${clientId}, issuer: ${issuer}`,
      );
      const credentials: Credentials = { agent: { webId }, issuer: { url: issuer } };
      if (clientId) {
        credentials.client = { clientId };
      }
      return credentials;
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      const message = `Error verifying WebID via DPoP-bound access token: ${reason}`;
      this.logger.warn(message);
      throw new BadRequestHttpError(message, { cause: error });
    }
  }

  private async verifyWithLocalRouteFallback(
    request: HttpRequest,
    authorization: string,
    dpopOptions: DPoPOptions,
  ): ReturnType<SolidTokenVerifierFunction> {
    try {
      return await this.verify(authorization, dpopOptions);
    } catch (error: unknown) {
      const localRouteUrl = this.trustedLocalRouteUrl(request, dpopOptions.url);
      if (!localRouteUrl) {
        throw error;
      }
      return this.verify(authorization, {
        ...dpopOptions,
        url: localRouteUrl,
      });
    }
  }

  private trustedLocalRouteUrl(request: HttpRequest, canonicalUrl: string): string | undefined {
    const localRouteUrl = firstHeaderValue(request.headers[SOLID_LOCAL_ROUTE_LOCAL_URL_HEADER]);
    const routeCanonicalUrl = firstHeaderValue(request.headers[SOLID_LOCAL_ROUTE_CANONICAL_URL_HEADER]);
    if (!localRouteUrl || routeCanonicalUrl !== canonicalUrl || !this.trustedLocalRouteTransport(request)) {
      return undefined;
    }
    try {
      const url = new URL(localRouteUrl);
      return url.protocol === 'http:' && isLoopbackIp(url.hostname) ? url.toString() : undefined;
    } catch {
      return undefined;
    }
  }

  private trustedLocalRouteTransport(request: HttpRequest): boolean {
    if (isLoopbackRemoteAddress(request.socket.remoteAddress)) {
      return true;
    }

    const verification = verifyGatewayAdminProxyHeaders({
      headers: request.headers,
      secret: process.env.XPOD_GATEWAY_ADMIN_PROXY_AUTH_SECRET,
      method: request.method,
      url: request.url,
    });
    return verification.valid && verification.originalClientLoopback;
  }
}

export function deriveCssLoopbackBaseUrl(cssPort: string | undefined): string | undefined {
  const port = Number(cssPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return undefined;
  }
  return `http://127.0.0.1:${port}/`;
}

function isDpopRequestMethod(method: string | undefined): method is DPoPOptions['method'] {
  return typeof method === 'string' && REQUEST_METHOD.has(method as DPoPOptions['method']);
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isLoopbackRemoteAddress(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false;
  const normalized = remoteAddress.startsWith('::ffff:')
    ? remoteAddress.slice('::ffff:'.length)
    : remoteAddress;

  return normalized === '::1' || isLoopbackIp(normalized);
}

function isLoopbackIp(hostname: string): boolean {
  const normalized = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
  if (normalized === '::1') {
    return true;
  }
  const octets = normalized.split('.');
  return octets.length === 4
    && octets[0] === '127'
    && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255);
}
