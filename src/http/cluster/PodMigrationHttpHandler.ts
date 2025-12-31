import type { IncomingMessage } from 'node:http';
import { getLoggerFor } from 'global-logger-factory';
import { HttpHandler } from '@solid/community-server';
import type { HttpHandlerInput, HttpResponse } from '@solid/community-server';
import {
  NotImplementedHttpError,
  BadRequestHttpError,
  NotFoundHttpError,
  
} from '@solid/community-server';
import { getIdentityDatabase } from '../../identity/drizzle/db';
import { PodLookupRepository } from '../../identity/drizzle/PodLookupRepository';
import { EdgeNodeRepository } from '../../identity/drizzle/EdgeNodeRepository';
import { PodMigrationService } from '../../service/PodMigrationService';

interface PodMigrationHttpHandlerOptions {
  identityDbUrl: string;
  currentNodeId: string;
  basePath?: string;
  enabled?: boolean | string;
}

interface MigrateRequest {
  targetNode: string;
}

/**
 * HTTP Handler for Pod migration operations.
 * 
 * Migration is now instant - it only updates the nodeId in the database.
 * Binary files are read via cross-region fallback (TieredMinioDataAccessor).
 * 
 * Endpoints:
 * - POST /.cluster/pods/{podId}/migrate - Migrate pod to target node (instant)
 * - GET  /.cluster/pods/{podId} - Get pod info
 * - GET  /.cluster/pods - List all pods with node info
 */
export class PodMigrationHttpHandler extends HttpHandler {
  protected readonly logger = getLoggerFor(this);
  
  private readonly podLookupRepository: PodLookupRepository;
  private readonly edgeNodeRepository: EdgeNodeRepository;
  private readonly migrationService: PodMigrationService;
  private readonly basePath: string;
  private readonly basePathWithSlash: string;
  private readonly enabled: boolean;

  public constructor(options: PodMigrationHttpHandlerOptions) {
    super();
    const db = getIdentityDatabase(options.identityDbUrl);
    this.podLookupRepository = new PodLookupRepository(db);
    this.edgeNodeRepository = new EdgeNodeRepository(db);
    this.migrationService = new PodMigrationService({
      identityDbUrl: options.identityDbUrl,
      currentNodeId: options.currentNodeId,
    });
    this.basePath = this.normalizeBasePath(options.basePath ?? '/.cluster/pods');
    this.basePathWithSlash = `${this.basePath}/`;
    this.enabled = this.normalizeBoolean(options.enabled);

    this.logger.info(`PodMigrationHttpHandler initialized: basePath=${this.basePath}, enabled=${this.enabled}`);
  }

  public override async canHandle({ request }: HttpHandlerInput): Promise<void> {
    if (!this.enabled) {
      throw new NotImplementedHttpError('Pod migration API disabled.');
    }

    const url = this.parseUrl(request);
    if (!this.matchesPath(url.pathname)) {
      throw new NotImplementedHttpError(`Path ${url.pathname} does not match ${this.basePath}`);
    }
  }

  public override async handle({ request, response }: HttpHandlerInput): Promise<void> {
    const url = this.parseUrl(request);
    const method = (request.method ?? 'GET').toUpperCase();
    const relativePath = this.getRelativePath(url.pathname);

    try {
      // GET /.cluster/pods - List pods
      if (relativePath === '' && method === 'GET') {
        await this.handleListPods(response);
        return;
      }

      // Parse pod ID and action
      const match = relativePath.match(/^([^/]+)(?:\/(.+))?$/);
      if (!match) {
        throw new BadRequestHttpError('Invalid path format. Expected: /pods/{podId} or /pods/{podId}/migrate');
      }

      const podId = decodeURIComponent(match[1]);
      const action = match[2];

      // GET /.cluster/pods/{podId} - Get pod info
      if (!action && method === 'GET') {
        await this.handleGetPod(podId, response);
        return;
      }

      // POST /.cluster/pods/{podId}/migrate - Migrate pod (instant)
      if (action === 'migrate' && method === 'POST') {
        const body = await this.parseJsonBody(request);
        await this.handleMigrate(podId, body, response);
        return;
      }

      throw new NotImplementedHttpError(`${method} ${url.pathname} not implemented`);
    } catch (error: unknown) {
      if (error instanceof BadRequestHttpError || 
          error instanceof NotFoundHttpError ||
          error instanceof NotImplementedHttpError) {
        throw error;
      }
      this.logger.error(`Error handling ${method} ${url.pathname}: ${(error as Error).message}`);
      throw error;
    }
  }

  /**
   * List all pods with their node assignments.
   */
  private async handleListPods(response: HttpResponse): Promise<void> {
    const pods = await this.podLookupRepository.listAllPods();
    
    this.sendJson(response, 200, {
      pods: pods.map(pod => ({
        podId: pod.podId,
        baseUrl: pod.baseUrl,
        accountId: pod.accountId,
        nodeId: pod.nodeId,
      })),
    });
  }

  /**
   * Get single pod info.
   */
  private async handleGetPod(podId: string, response: HttpResponse): Promise<void> {
    const pod = await this.podLookupRepository.findById(podId);
    if (!pod) {
      throw new NotFoundHttpError(`Pod ${podId} not found`);
    }

    this.sendJson(response, 200, {
      podId: pod.podId,
      baseUrl: pod.baseUrl,
      accountId: pod.accountId,
      nodeId: pod.nodeId,
    });
  }

  /**
   * Migrate pod to target node.
   * This is instant - only updates nodeId. Binary files use cross-region fallback.
   */
  private async handleMigrate(
    podId: string,
    body: MigrateRequest,
    response: HttpResponse,
  ): Promise<void> {
    if (!body.targetNode) {
      throw new BadRequestHttpError('Missing required field: targetNode');
    }

    try {
      const result = await this.migrationService.migratePod(podId, body.targetNode);

      this.logger.info(`Pod migrated: pod=${podId}, from=${result.sourceNodeId}, to=${result.targetNodeId}`);

      this.sendJson(response, 200, {
        message: 'Migration completed',
        podId: result.podId,
        sourceNode: result.sourceNodeId,
        targetNode: result.targetNodeId,
        migratedAt: result.migratedAt.toISOString(),
      });
    } catch (error) {
      const message = (error as Error).message;
      
      if (message.includes('not found')) {
        throw new NotFoundHttpError(message);
      }
      if (message.includes('already on node')) {
        throw new BadRequestHttpError(message);
      }
      
      throw error;
    }
  }

  // ============ Utility methods ============

  private matchesPath(pathname: string): boolean {
    return pathname === this.basePath || pathname.startsWith(this.basePathWithSlash);
  }

  private getRelativePath(pathname: string): string {
    if (pathname === this.basePath) {
      return '';
    }
    if (pathname.startsWith(this.basePathWithSlash)) {
      return pathname.slice(this.basePathWithSlash.length);
    }
    return '';
  }

  private normalizeBasePath(basePath: string): string {
    let normalized = basePath;
    if (!normalized.startsWith('/')) {
      normalized = `/${normalized}`;
    }
    if (normalized.endsWith('/')) {
      normalized = normalized.slice(0, -1);
    }
    return normalized;
  }

  private parseUrl(request: IncomingMessage): URL {
    const hostHeader = request.headers.host ?? 'localhost';
    return new URL(request.url ?? '/', `http://${hostHeader}`);
  }

  private async parseJsonBody(request: IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        try {
          const body = Buffer.concat(chunks).toString('utf-8');
          resolve(body ? JSON.parse(body) : {});
        } catch (error) {
          reject(new BadRequestHttpError('Invalid JSON body'));
        }
      });
      request.on('error', reject);
    });
  }

  private sendJson(response: HttpResponse, status: number, data: object): void {
    const body = JSON.stringify(data);
    response.statusCode = status;
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('Content-Length', Buffer.byteLength(body));
    response.end(body);
  }

  private normalizeBoolean(value?: string | boolean): boolean {
    if (typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
    }
    return true; // Enabled by default
  }
}
