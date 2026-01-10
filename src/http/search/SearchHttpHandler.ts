/**
 * SearchHttpHandler - 语义搜索 HTTP 处理器
 *
 * 提供 /-/search 端点，支持基于向量的语义搜索。
 *
 * 端点：
 * - GET  {path}/-/search?q=...     简单搜索
 * - POST {path}/-/search           复杂搜索（支持 filter 等）
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
import type { VectorStore } from '../../storage/vector/VectorStore';
import type { EmbeddingService } from '../../embedding/EmbeddingService';
import type { SparqlEngine } from '../../storage/sparql/SubgraphQueryEngine';
import type { AiCredential } from '../../embedding/types';
import type { VectorSearchOptions } from '../../storage/vector/types';

const ALLOWED_METHODS = ['GET', 'POST', 'OPTIONS'];

// ============================================
// 请求/响应类型
// ============================================

interface SearchRequest {
  /** 查询文本 */
  query?: string;
  /** 预计算的查询向量 */
  vector?: number[];
  /** 返回结果数量，默认 10 */
  limit?: number;
  /** 相似度阈值 (0-1) */
  threshold?: number;
  /** 过滤条件 */
  filter?: {
    type?: string;
    graphPrefix?: string;
    subjectPrefix?: string;
  };
  /** embedding 模型 */
  model?: string;
}

interface SearchResult {
  /** 资源 URI */
  subject: string;
  /** 相似度分数 (0-1) */
  score: number;
  /** 距离 */
  distance?: number;
  /** 文本片段 */
  snippet?: string;
}

interface SearchResponse {
  results: SearchResult[];
  model: string;
  took_ms: number;
}

// ============================================
// 错误处理
// ============================================

type SearchErrorCode =
  | 'INVALID_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NO_CREDENTIAL'
  | 'EMBEDDING_ERROR'
  | 'SEARCH_ERROR';

class SearchApiError extends Error {
  constructor(
    public readonly code: SearchErrorCode,
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'SearchApiError';
  }

  static invalidRequest(message: string): SearchApiError {
    return new SearchApiError('INVALID_REQUEST', 400, message);
  }

  static noCredential(): SearchApiError {
    return new SearchApiError('NO_CREDENTIAL', 400, 'No AI credential found. Please configure AI credentials in your Pod settings.');
  }

  static embeddingError(message: string): SearchApiError {
    return new SearchApiError('EMBEDDING_ERROR', 502, `Embedding generation failed: ${message}`);
  }

  static searchError(message: string): SearchApiError {
    return new SearchApiError('SEARCH_ERROR', 500, `Search failed: ${message}`);
  }
}

// ============================================
// Handler
// ============================================

export interface SearchHttpHandlerOptions {
  sidecarPath?: string;
  defaultModel?: string;
  defaultLimit?: number;
}

export class SearchHttpHandler extends HttpHandler {
  protected readonly logger = getLoggerFor(this);

  private readonly vectorStore: VectorStore;
  private readonly embeddingService: EmbeddingService;
  private readonly sparqlEngine: SparqlEngine;
  private readonly credentialsExtractor: CredentialsExtractor;
  private readonly permissionReader: PermissionReader;
  private readonly authorizer: Authorizer;
  private readonly sidecarPath: string;
  private readonly defaultModel: string;
  private readonly defaultLimit: number;

  public constructor(
    vectorStore: VectorStore,
    embeddingService: EmbeddingService,
    sparqlEngine: SparqlEngine,
    credentialsExtractor: CredentialsExtractor,
    permissionReader: PermissionReader,
    authorizer: Authorizer,
    options: SearchHttpHandlerOptions = {},
  ) {
    super();
    this.vectorStore = vectorStore;
    this.embeddingService = embeddingService;
    this.sparqlEngine = sparqlEngine;
    this.credentialsExtractor = credentialsExtractor;
    this.permissionReader = permissionReader;
    this.authorizer = authorizer;
    this.sidecarPath = options.sidecarPath ?? '/-/search';
    this.defaultModel = options.defaultModel ?? 'text-embedding-004';
    this.defaultLimit = options.defaultLimit ?? 10;
  }

  public override async canHandle({ request }: HttpHandlerInput): Promise<void> {
    const path = this.parseUrl(request).pathname;
    if (!path.includes(this.sidecarPath)) {
      throw new NotImplementedHttpError('Request is not targeting a search endpoint.');
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
        throw new NotImplementedHttpError('Request is not targeting a search endpoint.');
      }

      // 提取 base path（sidecar 之前的路径）
      let basePath = path.slice(0, sidecarIndex);
      if (!basePath.endsWith('/')) {
        basePath = `${basePath}/`;
      }

      const origin = `${url.protocol}//${url.host}`;
      const baseUrl = `${origin}${basePath}`;

      this.logger.debug(`Search request: ${method} ${path}, baseUrl=${baseUrl}`);

      // 鉴权
      await this.authorizeFor(baseUrl, request, [PERMISSIONS.Read]);

      // 解析请求
      const searchRequest = await this.parseSearchRequest(request, url);

      // 执行搜索
      const result = await this.executeSearch(searchRequest, baseUrl);

      this.sendJsonResponse(response, result);
    } catch (error: unknown) {
      this.handleError(response, error);
    }
  }

  /**
   * 解析搜索请求
   */
  private async parseSearchRequest(request: HttpRequest, url: URL): Promise<SearchRequest> {
    const method = (request.method ?? 'GET').toUpperCase();

    if (method === 'GET') {
      // GET 请求从 query string 解析
      const query = url.searchParams.get('q') || url.searchParams.get('query');
      const limit = url.searchParams.get('limit');
      const threshold = url.searchParams.get('threshold');
      const model = url.searchParams.get('model');

      if (!query) {
        throw SearchApiError.invalidRequest('Missing query parameter "q"');
      }

      return {
        query,
        limit: limit ? parseInt(limit, 10) : undefined,
        threshold: threshold ? parseFloat(threshold) : undefined,
        model: model || undefined,
      };
    }

    // POST 请求从 body 解析
    const body = await this.readJsonBody<SearchRequest>(request);

    if (!body.query && !body.vector) {
      throw SearchApiError.invalidRequest('Either "query" or "vector" is required');
    }

    return body;
  }

  /**
   * 执行搜索
   */
  private async executeSearch(request: SearchRequest, baseUrl: string): Promise<SearchResponse> {
    const startTime = Date.now();
    const model = request.model || this.defaultModel;

    let queryVector = request.vector;

    // 如果提供了 query 文本，需要生成 embedding
    if (request.query && !queryVector) {
      // 获取 AI 凭据
      const credential = await this.getAiCredential(baseUrl);
      if (!credential) {
        throw SearchApiError.noCredential();
      }

      try {
        queryVector = await this.embeddingService.embed(request.query, credential, model);
      } catch (error) {
        throw SearchApiError.embeddingError(error instanceof Error ? error.message : String(error));
      }
    }

    if (!queryVector) {
      throw SearchApiError.invalidRequest('Failed to generate query vector');
    }

    // 执行向量搜索
    const searchOptions: VectorSearchOptions = {
      limit: request.limit ?? this.defaultLimit,
      threshold: request.threshold,
    };

    try {
      const vectorResults = await this.vectorStore.search(model, queryVector, searchOptions);

      // 转换结果
      const results: SearchResult[] = vectorResults.map((r) => ({
        subject: this.vectorIdToSubject(r.id, baseUrl),
        score: r.score,
        distance: r.distance,
      }));

      return {
        results,
        model,
        took_ms: Date.now() - startTime,
      };
    } catch (error) {
      throw SearchApiError.searchError(error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * 获取 AI 凭据
   */
  private async getAiCredential(podBaseUrl: string): Promise<AiCredential | null> {
    try {
      const query = `
        PREFIX xpod: <https://xpod.dev/ns#>
        SELECT ?apiKey ?baseUrl ?provider ?proxyUrl WHERE {
          ?cred a xpod:Credential ;
                xpod:service "AI" ;
                xpod:status "active" ;
                xpod:apiKey ?apiKey .
          OPTIONAL { ?cred xpod:baseUrl ?baseUrl }
          OPTIONAL { ?cred xpod:provider ?provider }
          OPTIONAL { ?cred xpod:proxyUrl ?proxyUrl }
        } LIMIT 1
      `;

      const bindingsStream = await this.sparqlEngine.queryBindings(query, podBaseUrl);

      for await (const binding of bindingsStream) {
        const apiKey = binding.get('apiKey');
        const baseUrl = binding.get('baseUrl');
        const provider = binding.get('provider');
        const proxyUrl = binding.get('proxyUrl');

        if (apiKey) {
          return {
            apiKey: apiKey.value,
            baseUrl: baseUrl?.value,
            provider: provider?.value || 'google',
            proxyUrl: proxyUrl?.value,
          };
        }
      }

      return null;
    } catch (error) {
      this.logger.error(`Failed to query AI credential: ${error}`);
      return null;
    }
  }

  /**
   * 将向量 ID 转换回 subject URI
   * 注意：这是一个简化实现，实际需要维护 ID -> URI 的映射
   */
  private vectorIdToSubject(id: number, baseUrl: string): string {
    // TODO: 实现 ID -> URI 映射查询
    // 目前返回占位符
    return `${baseUrl}#vector-${id}`;
  }

  // ============================================
  // 辅助方法
  // ============================================

  private handleError(response: HttpResponse, error: unknown): void {
    if (error instanceof SearchApiError) {
      this.logger.error(`Search API error [${error.code}]: ${error.message}`);
      this.sendErrorResponse(response, error.statusCode, error.code, error.message);
      return;
    }

    if (error instanceof HttpError) {
      const errorMsg = error.message || error.name || `HTTP ${error.statusCode}`;
      this.logger.error(`HTTP error ${error.statusCode}: ${errorMsg}`);
      this.sendErrorResponse(response, error.statusCode, 'HTTP_ERROR', errorMsg);
      return;
    }

    const errorMsg = error instanceof Error ? error.message : String(error);
    this.logger.error(`Unexpected error: ${errorMsg}`);
    this.sendErrorResponse(response, 500, 'INTERNAL_ERROR', errorMsg || 'Internal server error');
  }

  private async authorizeFor(
    baseUrl: string,
    request: HttpRequest,
    permissions: typeof PERMISSIONS[keyof typeof PERMISSIONS][],
  ): Promise<void> {
    const credentials = await this.credentialsExtractor.handleSafe(request);
    const identifier: ResourceIdentifier = { path: baseUrl };
    const requestedModes = new IdentifierSetMultiMap([[identifier, permissions]] as any);

    const availablePermissions = await this.permissionReader.handleSafe({
      credentials,
      identifier,
      requestedModes,
    } as any);

    this.logger.debug(`authorizeFor: baseUrl=${baseUrl}, webId=${credentials.agent?.webId}`);

    await this.authorizer.handleSafe({
      credentials,
      identifier,
      requestedModes,
      availablePermissions,
    } as any);
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
      throw SearchApiError.invalidRequest('Invalid JSON body');
    }
  }

  private sendJsonResponse(response: HttpResponse, data: unknown, status = 200): void {
    response.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache',
    });
    response.end(JSON.stringify(data));
  }

  private sendErrorResponse(
    response: HttpResponse,
    status: number,
    code: string,
    message: string,
  ): void {
    response.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache',
    });
    response.end(
      JSON.stringify({
        error: true,
        code,
        message,
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
