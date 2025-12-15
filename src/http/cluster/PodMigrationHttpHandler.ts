import type { IncomingMessage } from 'node:http';
import { HttpHandler } from '@solid/community-server';
import type { HttpHandlerInput, HttpResponse } from '@solid/community-server';
import {
  NotImplementedHttpError,
  BadRequestHttpError,
  NotFoundHttpError,
  getLoggerFor,
} from '@solid/community-server';
import { getIdentityDatabase } from '../../identity/drizzle/db';
import { PodLookupRepository } from '../../identity/drizzle/PodLookupRepository';
import { EdgeNodeRepository } from '../../identity/drizzle/EdgeNodeRepository';

interface PodMigrationHttpHandlerOptions {
  identityDbUrl: string;
  basePath?: string;
  enabled?: boolean | string;
}

interface MigrateRequest {
  targetNode: string;
}

/**
 * HTTP Handler for Pod migration operations.
 * 
 * Endpoints:
 * - POST /.cluster/pods/{podId}/migrate - Start migration
 * - GET  /.cluster/pods/{podId}/migration - Get migration status
 * - DELETE /.cluster/pods/{podId}/migration - Cancel migration
 * - GET  /.cluster/pods - List all pods with node info
 */
export class PodMigrationHttpHandler extends HttpHandler {
  protected readonly logger = getLoggerFor(this);
  
  private readonly podLookupRepository: PodLookupRepository;
  private readonly edgeNodeRepository: EdgeNodeRepository;
  private readonly basePath: string;
  private readonly basePathWithSlash: string;
  private readonly enabled: boolean;

  public constructor(options: PodMigrationHttpHandlerOptions) {
    super();
    const db = getIdentityDatabase(options.identityDbUrl);
    this.podLookupRepository = new PodLookupRepository(db);
    this.edgeNodeRepository = new EdgeNodeRepository(db);
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

      // POST /.cluster/pods/{podId}/migrate - Start migration
      if (action === 'migrate' && method === 'POST') {
        const body = await this.parseJsonBody(request);
        await this.handleStartMigration(podId, body, response);
        return;
      }

      // GET /.cluster/pods/{podId}/migration - Get migration status
      if (action === 'migration' && method === 'GET') {
        await this.handleGetMigrationStatus(podId, response);
        return;
      }

      // DELETE /.cluster/pods/{podId}/migration - Cancel migration
      if (action === 'migration' && method === 'DELETE') {
        await this.handleCancelMigration(podId, response);
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
   * Get single pod info including migration status.
   */
  private async handleGetPod(podId: string, response: HttpResponse): Promise<void> {
    const pod = await this.podLookupRepository.findById(podId);
    if (!pod) {
      throw new NotFoundHttpError(`Pod ${podId} not found`);
    }

    const migration = await this.podLookupRepository.getMigrationStatus(podId);

    this.sendJson(response, 200, {
      podId: pod.podId,
      baseUrl: pod.baseUrl,
      accountId: pod.accountId,
      nodeId: pod.nodeId,
      migration: migration ? {
        status: migration.migrationStatus,
        targetNode: migration.migrationTargetNode,
        progress: migration.migrationProgress,
      } : null,
    });
  }

  /**
   * Start pod migration to target node.
   */
  private async handleStartMigration(
    podId: string,
    body: MigrateRequest,
    response: HttpResponse,
  ): Promise<void> {
    if (!body.targetNode) {
      throw new BadRequestHttpError('Missing required field: targetNode');
    }

    // Verify pod exists
    const pod = await this.podLookupRepository.findById(podId);
    if (!pod) {
      throw new NotFoundHttpError(`Pod ${podId} not found`);
    }

    // Verify target node exists
    const targetNode = await this.edgeNodeRepository.getCenterNode(body.targetNode);
    if (!targetNode) {
      throw new BadRequestHttpError(`Target node ${body.targetNode} not found`);
    }

    // Check if already migrating
    const currentStatus = await this.podLookupRepository.getMigrationStatus(podId);
    if (currentStatus?.migrationStatus === 'syncing') {
      throw new BadRequestHttpError(`Pod ${podId} is already being migrated`);
    }

    // Check if already on target node
    if (pod.nodeId === body.targetNode) {
      throw new BadRequestHttpError(`Pod ${podId} is already on node ${body.targetNode}`);
    }

    // Start migration
    await this.podLookupRepository.setMigrationStatus(podId, 'syncing', body.targetNode, 0);

    this.logger.info(`Migration started: pod=${podId}, target=${body.targetNode}`);

    // TODO: Trigger actual migration process (Phase 3 full implementation)
    // For now, just mark as started

    this.sendJson(response, 202, {
      message: 'Migration started',
      podId,
      targetNode: body.targetNode,
      status: 'syncing',
      progress: 0,
    });
  }

  /**
   * Get migration status for a pod.
   */
  private async handleGetMigrationStatus(podId: string, response: HttpResponse): Promise<void> {
    const pod = await this.podLookupRepository.findById(podId);
    if (!pod) {
      throw new NotFoundHttpError(`Pod ${podId} not found`);
    }

    const status = await this.podLookupRepository.getMigrationStatus(podId);
    if (!status || !status.migrationStatus) {
      this.sendJson(response, 200, {
        podId,
        migrating: false,
      });
      return;
    }

    this.sendJson(response, 200, {
      podId,
      migrating: status.migrationStatus === 'syncing',
      status: status.migrationStatus,
      targetNode: status.migrationTargetNode,
      progress: status.migrationProgress,
    });
  }

  /**
   * Cancel ongoing migration.
   */
  private async handleCancelMigration(podId: string, response: HttpResponse): Promise<void> {
    const pod = await this.podLookupRepository.findById(podId);
    if (!pod) {
      throw new NotFoundHttpError(`Pod ${podId} not found`);
    }

    const status = await this.podLookupRepository.getMigrationStatus(podId);
    if (!status || status.migrationStatus !== 'syncing') {
      throw new BadRequestHttpError(`Pod ${podId} is not being migrated`);
    }

    // Clear migration status
    await this.podLookupRepository.setMigrationStatus(podId, null, null, null);

    this.logger.info(`Migration cancelled: pod=${podId}`);

    this.sendJson(response, 200, {
      message: 'Migration cancelled',
      podId,
    });
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
