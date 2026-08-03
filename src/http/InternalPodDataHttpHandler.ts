import { Readable } from 'node:stream';
import { getLoggerFor } from 'global-logger-factory';
import {
  BasicRepresentation,
  HttpHandler,
  NotImplementedHttpError,
  RepresentationMetadata,
  type HttpHandlerInput,
  type HttpRequest,
  type HttpResponse,
  type Representation,
  type ResourceStore,
} from '@solid/community-server';
import { createAiConnectionServiceAccess } from '../api/ai-gateway/service-access/AiConnectionServiceAccess';
import {
  isLoopbackRemoteAddress,
  verifyGatewayAdminProxyHeaders,
  type GatewayAdminProxyIntent,
} from '../runtime/GatewayAdminProxyAuth';

export interface InternalPodDataHttpHandlerOptions {
  resourceStore: ResourceStore;
  gatewayAdminProxyAuthSecret?: string;
  baseUrl?: string;
  basePath?: string;
}

type InternalPodDataMethod = 'GET' | 'PUT' | 'PATCH' | 'DELETE';

const ALLOWED_METHODS = new Set([ 'GET', 'PUT', 'PATCH', 'DELETE' ]);

export class InternalPodDataHttpHandler extends HttpHandler {
  protected readonly logger = getLoggerFor(this);
  private readonly resourceStore: ResourceStore;
  private readonly gatewayAdminProxyAuthSecret?: string;
  private readonly deploymentBaseUrl?: URL;
  private readonly basePath: string;
  private readonly seenNonces = new Set<string>();

  public constructor(options: InternalPodDataHttpHandlerOptions) {
    super();
    this.resourceStore = options.resourceStore;
    this.gatewayAdminProxyAuthSecret = options.gatewayAdminProxyAuthSecret ?? process.env.XPOD_GATEWAY_ADMIN_PROXY_AUTH_SECRET;
    this.deploymentBaseUrl = this.parseOptionalUrl(options.baseUrl ?? process.env.CSS_BASE_URL);
    this.basePath = options.basePath ?? '/.internal/pod-data';
  }

  public override async canHandle({ request }: HttpHandlerInput): Promise<void> {
    if (this.parseUrl(request).pathname !== this.basePath) {
      throw new NotImplementedHttpError('Not an internal Pod data request.');
    }
  }

  public override async handle({ request, response }: HttpHandlerInput): Promise<void> {
    if (this.parseUrl(request).pathname !== this.basePath) {
      throw new NotImplementedHttpError('Not an internal Pod data request.');
    }

    const intent = this.verifyRequest(request);
    if (!intent) {
      this.writeNotFound(response);
      return;
    }

    try {
      await this.delegate(request, response, intent);
    } catch (error: unknown) {
      if (isHttpNotFound(error)) {
        this.writeNotFound(response);
        return;
      }
      throw error;
    }
  }

  private verifyRequest(request: HttpRequest): GatewayAdminProxyIntent | undefined {
    const method = request.method?.toUpperCase();
    if (!ALLOWED_METHODS.has(method ?? '')) {
      return undefined;
    }
    if (!isLoopbackRemoteAddress(request.socket.remoteAddress)) {
      return undefined;
    }

    const verification = verifyGatewayAdminProxyHeaders({
      headers: request.headers,
      secret: this.gatewayAdminProxyAuthSecret,
      method,
      url: request.url,
    });
    if (!verification.valid || !verification.originalClientLoopback || !verification.intent || !verification.nonce) {
      return undefined;
    }
    if (this.seenNonces.has(verification.nonce)) {
      return undefined;
    }
    if (!this.intentMatchesRequest(verification.intent, method as InternalPodDataMethod)) {
      return undefined;
    }
    if (!this.isHostedOwnerResource(verification.intent)) {
      return undefined;
    }
    if (!this.isAllowedAiConnectionResource(verification.intent)) {
      return undefined;
    }

    this.seenNonces.add(verification.nonce);
    return verification.intent;
  }

  private intentMatchesRequest(intent: GatewayAdminProxyIntent, method: InternalPodDataMethod): boolean {
    if (intent.method !== method) {
      return false;
    }
    if (intent.scopes.length === 0) {
      return false;
    }
    const requiredScope = method === 'GET' ? 'ai:credentials:read' : 'ai:credentials:write';
    return intent.scopes.some((scope) =>
      scope === requiredScope ||
      scope === 'ai:credentials:*' ||
      scope === 'ai:*',
    );
  }

  private isHostedOwnerResource(intent: GatewayAdminProxyIntent): boolean {
    if (!this.deploymentBaseUrl) {
      return false;
    }

    let ownerUrl: URL;
    let resourceUrl: URL;
    try {
      ownerUrl = new URL(intent.ownerWebId);
      resourceUrl = new URL(intent.resourceUrl);
    } catch {
      return false;
    }
    if (!this.isInsideDeployment(ownerUrl) || !this.isInsideDeployment(resourceUrl)) {
      return false;
    }

    const podRoot = hostedPodRootFromOwner(ownerUrl);
    return podRoot !== undefined &&
      resourceUrl.origin === podRoot.origin &&
      resourceUrl.pathname.startsWith(podRoot.pathname);
  }

  private isAllowedAiConnectionResource(intent: GatewayAdminProxyIntent): boolean {
    let resourceUrl: URL;
    try {
      resourceUrl = new URL(intent.resourceUrl);
    } catch {
      return false;
    }
    if (resourceUrl.hash || resourceUrl.search) {
      return false;
    }
    const allowed = createAiConnectionServiceAccess({
      ownerWebId: intent.ownerWebId,
      serviceWebId: intent.ownerWebId,
    }).resources.map((resource) => resource.url);
    return allowed.includes(resourceUrl.href);
  }

  private async delegate(
    request: HttpRequest,
    response: HttpResponse,
    intent: GatewayAdminProxyIntent,
  ): Promise<void> {
    const identifier = { path: intent.resourceUrl };
    switch (intent.method) {
      case 'GET': {
        const representation = await this.resourceStore.getRepresentation(identifier, {
          type: { 'text/turtle': 1, '*/*': 0.1 },
        });
        response.statusCode = 200;
        response.setHeader('Content-Type', representation.metadata.contentType ?? 'text/turtle');
        await this.pipeRepresentation(representation, response);
        return;
      }
      case 'PUT': {
        await this.resourceStore.setRepresentation(identifier, this.createRepresentation(request, intent.resourceUrl));
        response.statusCode = 204;
        response.end();
        return;
      }
      case 'PATCH': {
        await this.resourceStore.modifyResource(identifier, this.createRepresentation(request, intent.resourceUrl) as any);
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
      new RepresentationMetadata({ path: resourceUrl }, { 'content-type': contentType }),
    );
  }

  private async pipeRepresentation(representation: Representation, response: HttpResponse): Promise<void> {
    for await (const chunk of representation.data as Readable) {
      response.write(chunk);
    }
    response.end();
  }

  private writeNotFound(response: HttpResponse): void {
    response.statusCode = 404;
    response.setHeader('Cache-Control', 'no-store');
    response.end('Not Found');
  }

  private parseUrl(request: HttpRequest): URL {
    return new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
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

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}
