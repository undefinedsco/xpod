import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import type { IncomingMessage } from 'node:http';
import type { Readable } from 'node:stream';
import { lookup as lookupMime } from 'mime-types';
import { HttpHandler } from '@solid/community-server';
import type { Credentials, HttpHandlerInput, HttpRequest, HttpResponse } from '@solid/community-server';
import {
  NotImplementedHttpError,
  MethodNotAllowedHttpError,
  InternalServerError,
  BadRequestHttpError,
  ForbiddenHttpError,
  getLoggerFor,
} from '@solid/community-server';
import type { CredentialsExtractor } from '@solid/community-server';
import { getIdentityDatabase } from '../../identity/drizzle/db';
import { AdminConsoleRepository } from '../../identity/drizzle/AdminConsoleRepository';
import { EdgeNodeRepository } from '../../identity/drizzle/EdgeNodeRepository';
import { AccountRoleRepository } from '../../identity/drizzle/AccountRoleRepository';

const DEFAULT_BASE_PATH = '/admin';
const DEFAULT_STATIC_DIRECTORY = path.resolve(__dirname, '..', '..', 'ui', 'admin');
const INDEX_FILENAME = 'index.html';

type Edition = 'cluster' | 'local';

interface AdminConsoleHttpHandlerOptions {
  identityDbUrl: string;
  credentialsExtractor: CredentialsExtractor;
  basePath?: string;
  staticDirectory?: string;
  edition?: Edition;
  publicBaseUrl?: string;
  signalEndpoint?: string;
  edgeNodesEnabled?: string | boolean;
  roleRepository?: AccountRoleRepository;
}

export class AdminConsoleHttpHandler extends HttpHandler {
  protected readonly logger = getLoggerFor(this);
  private readonly repo: AdminConsoleRepository;
  private readonly nodeRepo: EdgeNodeRepository;
  private readonly roleRepo: AccountRoleRepository;
  private readonly credentialsExtractor: CredentialsExtractor;
  private readonly basePath: string;
  private readonly basePathWithSlash: string;
  private readonly staticDirectory: string;
  private readonly edition: Edition;
  private readonly publicBaseUrl?: string;
  private readonly signalEndpoint?: string;
  private readonly edgeNodesEnabled: boolean;

  public constructor(options: AdminConsoleHttpHandlerOptions) {
    super();
    const db = getIdentityDatabase(options.identityDbUrl);
    this.repo = new AdminConsoleRepository(db);
    this.nodeRepo = new EdgeNodeRepository(db);
    this.roleRepo = options.roleRepository ?? new AccountRoleRepository(db);
    this.credentialsExtractor = options.credentialsExtractor;
    this.basePath = this.normalizeBasePath(options.basePath ?? DEFAULT_BASE_PATH);
    this.basePathWithSlash = `${this.basePath}/`;
    this.staticDirectory = path.resolve(options.staticDirectory ?? DEFAULT_STATIC_DIRECTORY);
    this.edition = options.edition ?? 'cluster';
    this.signalEndpoint = this.normalizeOptional(options.signalEndpoint);
    this.publicBaseUrl = this.normalizeOptional(options.publicBaseUrl);
    this.edgeNodesEnabled = this.normalizeBoolean(options.edgeNodesEnabled);
    this.logger.info(`AdminConsoleHttpHandler initialized with basePath=${this.basePath} staticDirectory=${this.staticDirectory}`);
  }

  public override async canHandle({ request }: HttpHandlerInput): Promise<void> {
    const pathname = this.parseUrl(request).pathname;
    if (!this.matchesBase(pathname)) {
      throw new NotImplementedHttpError('Not an admin console request.');
    }
    this.logger.info(`AdminConsoleHttpHandler matched path ${pathname}`);
  }

  public override async handle({ request, response }: HttpHandlerInput): Promise<void> {
    const method = (request.method ?? 'GET').toUpperCase();
    if (method === 'OPTIONS') {
      this.writeOptions(response);
      return;
    }

    const allowedStaticMethods = [ 'GET', 'HEAD' ];
    if (![ ...allowedStaticMethods, 'POST' ].includes(method)) {
      throw new MethodNotAllowedHttpError([ 'GET', 'HEAD', 'POST', 'OPTIONS' ]);
    }

    const url = this.parseUrl(request);
    const relative = this.toRelative(url.pathname);
    if (relative == null) {
      throw new NotImplementedHttpError('Request outside the admin console base path.');
    }

    if (relative === 'config') {
      if (method === 'HEAD') {
        response.statusCode = 204;
        response.end();
        return;
      }
      if (method !== 'GET') {
        throw new MethodNotAllowedHttpError([ 'GET', 'HEAD', 'OPTIONS' ]);
      }
      this.writeJson(response, 200, {
        edition: this.edition,
        features: {
          quota: this.edition === 'cluster',
          nodes: this.edgeNodesEnabled,
        },
        baseUrl: this.publicBaseUrl ?? null,
        signalEndpoint: this.signalEndpoint ?? null,
      });
      return;
    }

    if (relative === 'accounts') {
      await this.requireAdmin(request);
      if (method === 'HEAD') {
        response.statusCode = 204;
        response.end();
        return;
      }
      if (method !== 'GET') {
        throw new MethodNotAllowedHttpError([ 'GET', 'HEAD', 'OPTIONS' ]);
      }
      const overview = await this.repo.fetchOverview();
      this.writeJson(response, 200, {
        accounts: overview.accounts,
      });
      return;
    }

    if (relative === 'pods') {
      await this.requireAdmin(request);
      if (method === 'HEAD') {
        response.statusCode = 204;
        response.end();
        return;
      }
      if (method !== 'GET') {
        throw new MethodNotAllowedHttpError([ 'GET', 'HEAD', 'OPTIONS' ]);
      }
      const overview = await this.repo.fetchOverview();
      this.writeJson(response, 200, {
        pods: overview.pods,
      });
      return;
    }

    if (relative.startsWith('pods/')) {
      throw new NotImplementedHttpError('Not an admin console request.');
    }

    if (relative === 'nodes') {
      if (!this.edgeNodesEnabled) {
        throw new NotImplementedHttpError('Edge node registry disabled.');
      }
      await this.handleNodes(request, response, method);
      return;
    }

    if (allowedStaticMethods.includes(method)) {
      const isIndexRequest = relative.length === 0 || relative === INDEX_FILENAME;
      const credentials = await this.credentialsExtractor.handleSafe(request);
      if (!credentials.agent?.webId) {
        if (isIndexRequest) {
          this.redirectToLogin(request, response, url);
          return;
        }
        throw new ForbiddenHttpError('仅限管理员执行此操作。');
      }
      await this.ensureAdmin(credentials);
    }

    await this.serveStatic(request, response, method, relative);
  }

  private async handleNodes(request: HttpRequest, response: HttpResponse, method: string): Promise<void> {
    if (method === 'HEAD') {
      await this.requireAdmin(request);
      response.statusCode = 204;
      response.end();
      return;
    }

    if (method === 'GET') {
      await this.requireAdmin(request);
      const nodes = await this.nodeRepo.listNodes();
      this.writeJson(response, 200, { nodes });
      return;
    }

    if (method === 'POST') {
      await this.requireAdmin(request);
      const payload = await this.readJson(request);
      if (payload == null || typeof payload !== 'object') {
        throw new BadRequestHttpError('请求体必须是 JSON 对象。');
      }
      const data = payload as Record<string, unknown>;
      const displayNameRaw = data.displayName;
      if (displayNameRaw != null && typeof displayNameRaw !== 'string') {
        throw new BadRequestHttpError('displayName 必须是字符串。');
      }
      const displayName = typeof displayNameRaw === 'string' ? displayNameRaw.trim() : undefined;
      const created = await this.nodeRepo.createNode(displayName && displayName.length > 0 ? displayName : undefined);
      this.writeJson(response, 201, created);
      return;
    }

    throw new MethodNotAllowedHttpError([ 'GET', 'HEAD', 'POST', 'OPTIONS' ]);
  }

  private async serveStatic(request: HttpRequest, response: HttpResponse, method: string, relativePath: string): Promise<void> {
    try {
      const target = await this.resolveStaticPath(relativePath);
      if (!target) {
        this.logger.warn(`Admin static asset missing for path '${relativePath}' resolved from '${request.url}'.`);
        throw new NotImplementedHttpError('Static asset missing.');
      }

      const { filePath, isIndex } = target;
      this.logger.info(`Serving admin asset ${filePath} (index=${isIndex})`);
      const mime = lookupMime(filePath) || (isIndex ? 'text/html' : 'application/octet-stream');
      if (isIndex) {
        response.writeHead(200, {
          'Content-Type': `${mime}; charset=utf-8`,
          'Cache-Control': 'no-store',
        });
        if (method === 'HEAD') {
          response.end();
          this.logger.info(`Completed HEAD for admin asset ${filePath} with status ${response.statusCode}`);
          return;
        }
        const data = await fs.readFile(filePath, 'utf8');
        response.end(data);
        this.logger.info(`Finished sending admin index with status ${response.statusCode}`);
        return;
      }
      const stream = this.openFileStream(filePath);
      response.writeHead(200, {
        'Content-Type': `${mime}; charset=utf-8`,
        'Cache-Control': 'public, max-age=600, immutable',
      });
      if (method === 'HEAD') {
        response.end();
        stream.destroy();
        this.logger.info(`Completed HEAD for admin asset ${filePath} with status ${response.statusCode}`);
        return;
      }
      stream.pipe(response);
    } catch (error: unknown) {
      if (error instanceof NotImplementedHttpError) {
        throw error;
      }
      this.logger.error(`Error serving admin asset: ${(error as Error).message}`);
      throw new InternalServerError('Failed to serve admin interface asset.', { cause: error });
    }
  }

  private async resolveStaticPath(relative: string): Promise<{ filePath: string; isIndex: boolean } | undefined> {
    const safeRelative = this.sanitize(relative);
    const candidate = safeRelative.length === 0 ? INDEX_FILENAME : safeRelative;
    let filePath = path.join(this.staticDirectory, candidate);
    filePath = path.resolve(filePath);

    if (!filePath.startsWith(this.staticDirectory)) {
      throw new BadRequestHttpError('Path traversal is not allowed.');
    }

    try {
      const stats = await fs.stat(filePath);
      if (stats.isDirectory()) {
        const nestedIndex = path.join(filePath, INDEX_FILENAME);
        await fs.access(nestedIndex);
        return { filePath: nestedIndex, isIndex: true };
      }
      return { filePath, isIndex: candidate === INDEX_FILENAME };
    } catch {
      const fallback = path.join(this.staticDirectory, INDEX_FILENAME);
      try {
        await fs.access(fallback);
        return { filePath: fallback, isIndex: true };
      } catch {
        return undefined;
      }
    }
  }

  private openFileStream(filePath: string): Readable {
    return createReadStream(filePath);
  }

  private async requireAdmin(request: HttpRequest): Promise<void> {
    const credentials = await this.credentialsExtractor.handleSafe(request);
    await this.ensureAdmin(credentials);
  }

  private matchesBase(pathname: string): boolean {
    return pathname === this.basePath || pathname.startsWith(this.basePathWithSlash);
  }

  private toRelative(pathname: string): string | null {
    if (pathname === this.basePath) {
      return '';
    }
    if (!pathname.startsWith(this.basePathWithSlash)) {
      return null;
    }
    return pathname.slice(this.basePathWithSlash.length);
  }

  private sanitize(relative: string): string {
    const decoded = decodeURIComponent(relative);
    const normalized = path.posix.normalize(decoded);
    if (normalized.startsWith('..')) {
      throw new BadRequestHttpError('Invalid path.');
    }
    return normalized.replace(/^\/+/, '');
  }

  private normalizeBasePath(input: string): string {
    if (!input.startsWith('/')) {
      throw new BadRequestHttpError('Admin console base path must start with /.');
    }
    return input.endsWith('/') ? input.slice(0, -1) : input;
  }

  private parseUrl(request: IncomingMessage): URL {
    const hostHeader = request.headers.host ?? request.headers.Host ?? 'localhost';
    const protoHeader = request.headers['x-forwarded-proto'] ?? request.headers['X-Forwarded-Proto'];
    const protocol = Array.isArray(protoHeader) ? protoHeader[0] : protoHeader;
    const scheme = typeof protocol === 'string' ? protocol.split(',')[0]?.trim() ?? 'http' : 'http';
    const rawUrl = request.url ?? '/';
    return new URL(rawUrl, `${scheme}://${hostHeader}`);
  }

  private writeOptions(response: HttpResponse): void {
    response.statusCode = 204;
    response.setHeader('Allow', 'GET,HEAD,POST,OPTIONS');
    response.end();
  }

  private writeJson(response: HttpResponse, status: number, payload: unknown): void {
    response.statusCode = status;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.end(JSON.stringify(payload));
  }

  private async readJson(request: HttpRequest): Promise<unknown> {
    const body = await this.readBody(request);
    if (!body) {
      return undefined;
    }
    try {
      return JSON.parse(body);
    } catch (error: unknown) {
      throw new BadRequestHttpError('请求体必须是有效的 JSON。', { cause: error });
    }
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

  private async ensureAdmin(credentials: Credentials): Promise<void> {
    const webId = credentials.agent?.webId;
    if (!webId) {
      throw new ForbiddenHttpError('仅限管理员执行此操作。');
    }
    const context = await this.roleRepo.findByWebId(webId);
    if (!context || !context.roles.includes('admin')) {
      throw new ForbiddenHttpError('仅限管理员执行此操作。');
    }
  }

  private redirectToLogin(request: HttpRequest, response: HttpResponse, currentUrl?: URL): void {
    const targetUrl = currentUrl ?? this.parseUrl(request);
    const normalizedTarget = this.basePath;
    const query = `?targetUri=${encodeURIComponent(normalizedTarget)}`;
    response.statusCode = 303;
    response.setHeader('Location', `/.account/login/password/${query}`);
    response.setHeader('Cache-Control', 'no-store');
    response.end();
    this.logger.info(`Redirecting unauthenticated admin request for ${targetUrl.pathname} to /.account/login/password/`);
  }

  private normalizeOptional(value?: string): string | undefined {
    if (!value) {
      return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  private normalizeBoolean(value?: string | boolean): boolean {
    if (typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
    }
    return false;
  }
}
