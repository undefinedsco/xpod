/**
 * VectorHttpHandler - 纯向量存储 HTTP API
 *
 * 提供 /-/vector 端点，只负责向量的存储和搜索，不访问 Pod 数据。
 * AI embedding 生成、credential 管理等逻辑由外部 API Server 处理。
 *
 * 端点设计：
 * - POST /-/vector/upsert   - 存入向量
 * - POST /-/vector/search   - 搜索向量（只接受向量输入）
 * - DELETE /-/vector/delete - 删除向量
 * - GET  /-/vector/status   - 索引状态
 */

import { getLoggerFor } from 'global-logger-factory';
import { HttpHandler } from '@solid/community-server';
import type { HttpHandlerInput, HttpRequest, HttpResponse } from '@solid/community-server';
import {
  NotImplementedHttpError,
  MethodNotAllowedHttpError,
  HttpError,
  IdentifierSetMultiMap,
} from '@solid/community-server';
import { PERMISSIONS } from '@solidlab/policy-engine';
import type { CredentialsExtractor, PermissionReader, Authorizer, ResourceIdentifier } from '@solid/community-server';
import { VectorStore } from '../../storage/vector/VectorStore';
import type { VectorSearchOptions, VectorSearchResult } from '../../storage/vector/types';

const ALLOWED_METHODS = ['GET', 'POST', 'DELETE', 'OPTIONS'];

// ============================================
// 统一错误处理
// ============================================

type VectorErrorCode =
  | 'INVALID_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'DIMENSION_MISMATCH'
  | 'STORAGE_ERROR';

class VectorApiError extends Error {
  constructor(
    public readonly code: VectorErrorCode,
    public readonly statusCode: number,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'VectorApiError';
  }

  static invalidRequest(message: string, details?: Record<string, unknown>): VectorApiError {
    return new VectorApiError('INVALID_REQUEST', 400, message, details);
  }

  static unauthorized(message: string): VectorApiError {
    return new VectorApiError('UNAUTHORIZED', 401, message);
  }

  static notFound(action: string): VectorApiError {
    return new VectorApiError('NOT_FOUND', 404, `Unknown vector action: ${action}`);
  }

  static dimensionMismatch(expected: number, actual: number): VectorApiError {
    return new VectorApiError('DIMENSION_MISMATCH', 422, `Vector dimension mismatch: expected ${expected}, got ${actual}`, {
      expected,
      actual,
    });
  }

  static storageError(message: string): VectorApiError {
    return new VectorApiError('STORAGE_ERROR', 500, message);
  }
}

// ============================================
// 请求/响应类型
// ============================================

interface UpsertRequest {
  /** 模型名，如 text-embedding-004 */
  model: string;
  /** 要存入的向量列表 */
  vectors: {
    /** 向量 ID（通常是 subject URI 的哈希） */
    id: number;
    /** 向量数据 */
    vector: number[];
    /** 可选的元数据 */
    metadata?: Record<string, unknown>;
  }[];
}

interface SearchRequest {
  /** 模型名 */
  model: string;
  /** 查询向量 */
  vector: number[];
  /** 返回结果数量，默认 10 */
  limit?: number;
  /** 相似度阈值 */
  threshold?: number;
  /** 排除的 ID 列表 */
  excludeIds?: number[];
}

interface DeleteRequest {
  /** 模型名 */
  model: string;
  /** 要删除的向量 ID 列表 */
  ids: number[];
}

interface VectorHttpHandlerOptions {
  sidecarPath?: string;
}

export class VectorHttpHandler extends HttpHandler {
  protected readonly logger = getLoggerFor(this);

  private readonly vectorStore: VectorStore;
  private readonly credentialsExtractor: CredentialsExtractor;
  private readonly permissionReader: PermissionReader;
  private readonly authorizer: Authorizer;
  private readonly sidecarPath: string;

  public constructor(
    vectorStore: VectorStore,
    credentialsExtractor: CredentialsExtractor,
    permissionReader: PermissionReader,
    authorizer: Authorizer,
    options: VectorHttpHandlerOptions = {},
  ) {
    super();
    this.vectorStore = vectorStore;
    this.credentialsExtractor = credentialsExtractor;
    this.permissionReader = permissionReader;
    this.authorizer = authorizer;
    this.sidecarPath = options.sidecarPath ?? '/-/vector';
  }

  public override async canHandle({ request }: HttpHandlerInput): Promise<void> {
    const path = this.parseUrl(request).pathname;
    if (!path.includes(this.sidecarPath)) {
      throw new NotImplementedHttpError('Request is not targeting a vector endpoint.');
    }
  }

  public override async handle({ request, response }: HttpHandlerInput): Promise<void> {
    const method = (request.method ?? 'GET').toUpperCase();

    if (method === 'OPTIONS') {
      this.writeOptions(response);
      return;
    }

    if (!ALLOWED_METHODS.includes(method)) {
      throw new MethodNotAllowedHttpError(ALLOWED_METHODS);
    }

    try {
      const url = this.parseUrl(request);
      const path = decodeURIComponent(url.pathname);

      const sidecarIndex = path.indexOf(this.sidecarPath);
      if (sidecarIndex === -1) {
        throw new NotImplementedHttpError('Request is not targeting a vector endpoint.');
      }

      let basePath = path.slice(0, sidecarIndex);
      if (!basePath.endsWith('/')) {
        basePath = `${basePath}/`;
      }

      const actionPath = path.slice(sidecarIndex + this.sidecarPath.length);
      const action = actionPath.replace(/^\//, '').split('/')[0] || '';

      const origin = `${url.protocol}//${url.host}`;
      const baseUrl = `${origin}${basePath}`;

      this.logger.debug(`Vector request: ${method} ${path}, action=${action}, baseUrl=${baseUrl}`);

      switch (action) {
        case 'upsert':
          await this.handleUpsert(request, response, baseUrl, method);
          break;
        case 'search':
          await this.handleSearch(request, response, baseUrl, method);
          break;
        case 'delete':
          await this.handleDelete(request, response, baseUrl, method);
          break;
        case 'status':
        case 'stats':
          await this.handleStatus(request, response, baseUrl, method);
          break;
        default:
          throw VectorApiError.notFound(action);
      }
    } catch (error: unknown) {
      this.handleError(response, error);
    }
  }

  // ============================================
  // HTTP Handlers
  // ============================================

  private async handleUpsert(request: HttpRequest, response: HttpResponse, baseUrl: string, method: string): Promise<void> {
    if (method !== 'POST') {
      throw new MethodNotAllowedHttpError(['POST']);
    }

    const startTime = Date.now();
    await this.authorizeFor(baseUrl, request, [PERMISSIONS.Append]);

    const body = await this.readJsonBody<UpsertRequest>(request);

    if (!body.model) {
      throw VectorApiError.invalidRequest('Missing "model" field');
    }

    if (!Array.isArray(body.vectors) || body.vectors.length === 0) {
      throw VectorApiError.invalidRequest('Missing or empty "vectors" field');
    }

    // 确保向量表存在
    await this.vectorStore.ensureVectorTable(body.model);

    let upserted = 0;
    const errors: string[] = [];

    for (const item of body.vectors) {
      try {
        if (typeof item.id !== 'number') {
          throw new Error('Invalid id: must be a number');
        }
        if (!Array.isArray(item.vector) || item.vector.length === 0) {
          throw new Error('Invalid vector: must be a non-empty array');
        }

        await this.vectorStore.upsertVector(body.model, item.id, item.vector);
        upserted++;
      } catch (err) {
        errors.push(`id=${item.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    this.sendJsonResponse(response, {
      upserted,
      errors,
      took_ms: Date.now() - startTime,
    });
  }

  private async handleSearch(request: HttpRequest, response: HttpResponse, baseUrl: string, method: string): Promise<void> {
    if (method !== 'POST') {
      throw new MethodNotAllowedHttpError(['POST']);
    }

    const startTime = Date.now();
    await this.authorizeFor(baseUrl, request, [PERMISSIONS.Read]);

    const body = await this.readJsonBody<SearchRequest>(request);

    if (!body.model) {
      throw VectorApiError.invalidRequest('Missing "model" field');
    }

    if (!Array.isArray(body.vector) || body.vector.length === 0) {
      throw VectorApiError.invalidRequest('Missing or empty "vector" field');
    }

    const searchOptions: VectorSearchOptions = {
      limit: body.limit ?? 10,
      threshold: body.threshold,
      excludeIds: body.excludeIds ? new Set(body.excludeIds) : undefined,
    };

    const results = await this.vectorStore.search(body.model, body.vector, searchOptions);

    this.sendJsonResponse(response, {
      results: results.map((r: VectorSearchResult) => ({
        id: r.id,
        score: r.score,
        distance: r.distance,
      })),
      model: body.model,
      took_ms: Date.now() - startTime,
    });
  }

  private async handleDelete(request: HttpRequest, response: HttpResponse, baseUrl: string, method: string): Promise<void> {
    if (method !== 'POST' && method !== 'DELETE') {
      throw new MethodNotAllowedHttpError(['POST', 'DELETE']);
    }

    const startTime = Date.now();
    // 使用 Modify 权限，因为删除向量是对向量存储的修改操作
    await this.authorizeFor(baseUrl, request, [PERMISSIONS.Modify]);

    const body = await this.readJsonBody<DeleteRequest>(request);

    if (!body.model) {
      throw VectorApiError.invalidRequest('Missing "model" field');
    }

    if (!Array.isArray(body.ids) || body.ids.length === 0) {
      throw VectorApiError.invalidRequest('Missing or empty "ids" field');
    }

    let deleted = 0;
    const errors: string[] = [];

    for (const id of body.ids) {
      try {
        await this.vectorStore.deleteVector(body.model, id);
        deleted++;
      } catch (err) {
        errors.push(`id=${id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    this.sendJsonResponse(response, {
      deleted,
      errors,
      took_ms: Date.now() - startTime,
    });
  }

  private async handleStatus(request: HttpRequest, response: HttpResponse, baseUrl: string, method: string): Promise<void> {
    if (method !== 'GET') {
      throw new MethodNotAllowedHttpError(['GET']);
    }

    await this.authorizeFor(baseUrl, request, [PERMISSIONS.Read]);

    // 获取所有模型的向量统计
    const tables = await this.vectorStore.listVectorTables();
    const byModel: { model: string; count: number }[] = [];
    let totalCount = 0;

    for (const table of tables) {
      const count = await this.vectorStore.countVectors(table);
      byModel.push({ model: table, count });
      totalCount += count;
    }

    this.sendJsonResponse(response, { byModel, totalCount });
  }

  // ============================================
  // 辅助方法
  // ============================================

  private handleError(response: HttpResponse, error: unknown): void {
    if (error instanceof VectorApiError) {
      this.logger.error(`Vector API error [${error.code}]: ${error.message}`);
      this.sendErrorResponse(response, error);
      return;
    }

    if (error instanceof HttpError) {
      const errorMsg = error.message || error.name || `HTTP ${error.statusCode}`;
      this.logger.error(`HTTP error ${error.statusCode}: ${errorMsg}`);
      this.sendErrorResponse(response, new VectorApiError('INVALID_REQUEST', error.statusCode, errorMsg));
      return;
    }

    const errorMsg = error instanceof Error ? error.message : String(error);
    this.logger.error(`Unexpected error: ${errorMsg}`);
    this.sendErrorResponse(response, VectorApiError.storageError(errorMsg || 'Internal server error'));
  }

  private async authorizeFor(baseUrl: string, request: HttpRequest, permissions: typeof PERMISSIONS[keyof typeof PERMISSIONS][]): Promise<void> {
    const credentials = await this.credentialsExtractor.handleSafe(request);
    const identifier: ResourceIdentifier = { path: baseUrl };
    const requestedModes = new IdentifierSetMultiMap([[identifier, permissions]] as any);

    const availablePermissions = await this.permissionReader.handleSafe({ credentials, identifier, requestedModes } as any);

    this.logger.debug(`authorizeFor: baseUrl=${baseUrl}, webId=${credentials.agent?.webId}, requested=${permissions}`);

    await this.authorizer.handleSafe({ credentials, identifier, requestedModes, availablePermissions } as any);
  }

  private parseUrl(request: HttpRequest): URL {
    const protocol = request.headers['x-forwarded-proto'] || 'http';
    const host = request.headers['x-forwarded-host'] || request.headers.host || 'localhost';
    return new URL(request.url!, `${protocol}://${host}`);
  }

  private async readJsonBody<T>(request: HttpRequest): Promise<T> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks).toString('utf8');
    try {
      return JSON.parse(body) as T;
    } catch {
      throw VectorApiError.invalidRequest('Invalid JSON body');
    }
  }

  private sendJsonResponse(response: HttpResponse, data: unknown, status = 200): void {
    response.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache',
    });
    response.end(JSON.stringify(data));
  }

  private sendErrorResponse(response: HttpResponse, error: VectorApiError): void {
    response.writeHead(error.statusCode, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache',
    });
    response.end(
      JSON.stringify({
        error: true,
        code: error.code,
        message: error.message,
        details: error.details,
      }),
    );
  }

  private writeOptions(response: HttpResponse): void {
    response.writeHead(204, {
      'Access-Control-Allow-Methods': ALLOWED_METHODS.join(', '),
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    response.end();
  }
}
