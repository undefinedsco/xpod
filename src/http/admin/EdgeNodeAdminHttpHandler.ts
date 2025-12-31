import type { IncomingMessage } from 'node:http';
import { getLoggerFor } from 'global-logger-factory';
import { HttpHandler } from '@solid/community-server';
import type { HttpHandlerInput, HttpResponse } from '@solid/community-server';
import {
  BadRequestHttpError,
  InternalServerError,
  MethodNotAllowedHttpError,
  NotFoundHttpError,
  NotImplementedHttpError,
  
} from '@solid/community-server';
import { getIdentityDatabase } from '../../identity/drizzle/db';
import { EdgeNodeRepository } from '../../identity/drizzle/EdgeNodeRepository';
import { EdgeNodeCapabilityDetector } from '../../edge/EdgeNodeCapabilityDetector';

interface EdgeNodeAdminHttpHandlerOptions {
  identityDbUrl: string;
  basePath?: string;
  edgeNodesEnabled?: string | boolean;
  repository?: EdgeNodeRepository;
  capabilityDetector?: EdgeNodeCapabilityDetector;
}

/**
 * Edge Node Administration HTTP Handler
 * 
 * Provides REST API endpoints for edge node administration:
 * - GET /admin/nodes - List all nodes with their capabilities
 * - GET /admin/nodes/{nodeId} - Get specific node information
 * - GET /admin/nodes/{nodeId}/capabilities - Get node capability details
 */
export class EdgeNodeAdminHttpHandler extends HttpHandler {
  protected readonly logger = getLoggerFor(this);
  private readonly repo: EdgeNodeRepository;
  private readonly basePath: string;
  private readonly basePathWithSlash: string;
  private readonly enabled: boolean;
  private readonly capabilityDetector?: EdgeNodeCapabilityDetector;

  public constructor(options: EdgeNodeAdminHttpHandlerOptions) {
    super();
    this.repo = options.repository ?? new EdgeNodeRepository(getIdentityDatabase(options.identityDbUrl));
    this.basePath = this.normalizeBasePath(options.basePath ?? '/admin/nodes');
    this.basePathWithSlash = `${this.basePath}/`;
    this.enabled = this.normalizeBoolean(options.edgeNodesEnabled);
    this.capabilityDetector = options.capabilityDetector;
  }

  public override async canHandle({ request }: HttpHandlerInput): Promise<void> {
    if (!this.enabled) {
      throw new NotImplementedHttpError('Edge node admin API is disabled.');
    }
    const pathname = this.parseUrl(request).pathname;
    if (!this.matchesBase(pathname)) {
      throw new NotImplementedHttpError('Not an edge node admin request.');
    }
  }

  public override async handle({ request, response }: HttpHandlerInput): Promise<void> {
    const method = (request.method ?? 'GET').toUpperCase();
    if (method === 'OPTIONS') {
      this.writeOptions(response);
      return;
    }
    
    const url = this.parseUrl(request);
    const relative = this.toRelative(url.pathname);
    
    try {
      switch (method) {
        case 'GET':
          await this.handleGet(relative, response);
          break;
        case 'POST':
          await this.handlePost(relative, request, response);
          break;
        default:
          throw new MethodNotAllowedHttpError(['GET', 'POST', 'OPTIONS']);
      }
    } catch (error: unknown) {
      if (error instanceof Error) {
        this.logger.error(`Edge node admin API error: ${error.message}`);
      }
      throw error;
    }
  }

  private async handleGet(path: string, response: HttpResponse): Promise<void> {
    if (path === '') {
      // GET /admin/nodes - List all nodes
      await this.listNodes(response);
    } else {
      // Parse path segments
      const segments = path.split('/').filter(s => s.length > 0);
      
      if (segments.length === 1) {
        // GET /admin/nodes/{nodeId} - Get specific node
        await this.getNode(segments[0], response);
      } else if (segments.length === 2 && segments[1] === 'capabilities') {
        // GET /admin/nodes/{nodeId}/capabilities - Get node capabilities
        await this.getNodeCapabilities(segments[0], response);
      } else {
        throw new NotFoundHttpError('Unknown endpoint.');
      }
    }
  }

  private async listNodes(response: HttpResponse): Promise<void> {
    try {
      const nodes = await this.repo.listNodeCapabilities();
      
      const result = {
        nodes: nodes.map(node => ({
          nodeId: node.nodeId,
          accessMode: node.accessMode,
          connectivityStatus: node.connectivityStatus,
          lastSeen: node.lastSeen?.toISOString(),
          capabilities: {
            structured: node.capabilities,
            strings: node.stringCapabilities,
          },
        })),
        total: nodes.length,
        timestamp: new Date().toISOString(),
      };

      this.writeJsonResponse(response, result);
    } catch (error: unknown) {
      throw new InternalServerError('Failed to list edge nodes.', { cause: error });
    }
  }

  private async getNode(nodeId: string, response: HttpResponse): Promise<void> {
    try {
      const nodeInfo = await this.repo.getNodeCapabilities(nodeId);
      
      if (!nodeInfo) {
        throw new NotFoundHttpError(`Edge node '${nodeId}' not found.`);
      }

      const result = {
        nodeId: nodeInfo.nodeId,
        accessMode: nodeInfo.accessMode,
        connectivityStatus: nodeInfo.connectivityStatus,
        lastSeen: nodeInfo.lastSeen?.toISOString(),
        capabilities: {
          structured: nodeInfo.capabilities,
          strings: nodeInfo.stringCapabilities,
        },
        timestamp: new Date().toISOString(),
      };

      this.writeJsonResponse(response, result);
    } catch (error: unknown) {
      if (error instanceof NotFoundHttpError) {
        throw error;
      }
      throw new InternalServerError('Failed to get edge node information.', { cause: error });
    }
  }

  private async getNodeCapabilities(nodeId: string, response: HttpResponse): Promise<void> {
    try {
      const nodeInfo = await this.repo.getNodeCapabilities(nodeId);
      
      if (!nodeInfo) {
        throw new NotFoundHttpError(`Edge node '${nodeId}' not found.`);
      }

      // If we have a capability detector, also provide real-time capability detection
      let detectedCapabilities;
      if (this.capabilityDetector) {
        try {
          detectedCapabilities = await this.capabilityDetector.detectCapabilities();
        } catch (error: unknown) {
          this.logger.warn(`Failed to detect real-time capabilities for node ${nodeId}: ${(error as Error).message}`);
        }
      }

      const result = {
        nodeId: nodeInfo.nodeId,
        capabilities: {
          // Stored structured capabilities from the database
          stored: nodeInfo.capabilities,
          // String capabilities array for backward compatibility
          strings: nodeInfo.stringCapabilities,
          // Real-time detected capabilities (if available)
          detected: detectedCapabilities,
          // Parsed capabilities from strings for easier consumption
          parsed: nodeInfo.stringCapabilities ? 
            EdgeNodeCapabilityDetector.parseCapabilitiesFromStringArray(nodeInfo.stringCapabilities) : 
            null,
        },
        accessMode: nodeInfo.accessMode,
        connectivityStatus: nodeInfo.connectivityStatus,
        lastSeen: nodeInfo.lastSeen?.toISOString(),
        timestamp: new Date().toISOString(),
      };

      this.writeJsonResponse(response, result);
    } catch (error: unknown) {
      if (error instanceof NotFoundHttpError) {
        throw error;
      }
      throw new InternalServerError('Failed to get edge node capabilities.', { cause: error });
    }
  }

  private async handlePost(path: string, request: IncomingMessage, response: HttpResponse): Promise<void> {
    if (path === '') {
      // POST /admin/nodes - Create new node
      await this.createNode(request, response);
    } else {
      throw new NotFoundHttpError('Unknown endpoint.');
    }
  }

  private async createNode(request: IncomingMessage, response: HttpResponse): Promise<void> {
    const payload = await this.readRequestBody(request);
    let displayName: string | undefined;

    // Parse request body if provided
    if (payload) {
      try {
        const data = JSON.parse(payload);
        displayName = typeof data.displayName === 'string' ? data.displayName : undefined;
      } catch {
        // Ignore JSON parsing errors, displayName will remain undefined
      }
    }

    try {
      const result = await this.repo.createNode(displayName);
      
      this.logger.info(`Created new edge node: ${result.nodeId} (${displayName || 'no display name'})`);
      
      const response_data = {
        success: true,
        nodeId: result.nodeId,
        token: result.token,
        displayName: displayName,
        createdAt: result.createdAt,
        message: 'Edge node created successfully. Save the token - it will not be shown again.',
      };

      this.writeJsonResponse(response, response_data, 201);
    } catch (error: unknown) {
      this.logger.error(`Failed to create edge node: ${String(error)}`);
      throw new InternalServerError('Failed to create edge node.', { cause: error });
    }
  }

  private async readRequestBody(request: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = '';
      request.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      request.on('end', () => {
        resolve(body);
      });
      request.on('error', reject);
    });
  }

  private writeOptions(response: HttpResponse): void {
    response.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Max-Age': '86400',
    });
    response.end();
  }

  private writeJsonResponse(response: HttpResponse, data: unknown, statusCode = 200): void {
    const json = JSON.stringify(data, null, 2);
    response.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(json),
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    });
    response.end(json);
  }

  private parseUrl(request: IncomingMessage): URL {
    const urlString = request.url;
    if (!urlString) {
      throw new BadRequestHttpError('Invalid request URL.');
    }
    try {
      return new URL(urlString, `http://${request.headers.host ?? 'localhost'}`);
    } catch {
      throw new BadRequestHttpError('Invalid request URL format.');
    }
  }

  private matchesBase(pathname: string): boolean {
    return pathname === this.basePath || pathname.startsWith(this.basePathWithSlash);
  }

  private toRelative(pathname: string): string {
    if (pathname === this.basePath) {
      return '';
    }
    if (pathname.startsWith(this.basePathWithSlash)) {
      return pathname.substring(this.basePathWithSlash.length);
    }
    return pathname;
  }

  private normalizeBasePath(path: string): string {
    const trimmed = path.trim();
    if (!trimmed.startsWith('/')) {
      return `/${trimmed}`;
    }
    return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
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