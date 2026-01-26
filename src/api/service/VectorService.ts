import { getLoggerFor } from 'global-logger-factory';
import type { PodChatKitStore } from '../chatkit/pod-store';
import type { StoreContext } from '../chatkit/store';
import type { AuthContext } from '../auth/AuthContext';
import { getWebId, getAccountId } from '../auth/AuthContext';
import type { EmbeddingService } from '../../ai/service/EmbeddingService';
import type { AiCredential } from '../../ai/service/types';

/**
 * Vector upsert request
 */
export interface VectorUpsertRequest {
  /** Embedding model name */
  model: string;
  /** Vectors to upsert */
  vectors: Array<{
    /** Resource URI */
    subject: string;
    /** Semantic aspect (type, chunk, property) */
    aspect: string;
    /** Vector data */
    vector: number[];
  }>;
}

/**
 * Vector search request
 */
export interface VectorSearchRequest {
  /** Embedding model name */
  model: string;
  /** Query text (will be converted to vector) */
  query?: string;
  /** Pre-computed query vector */
  vector?: number[];
  /** Max results */
  limit?: number;
  /** Similarity threshold (0-1) */
  threshold?: number;
  /** Filter conditions */
  filter?: {
    subject?: { $eq?: string; $startsWith?: string; $in?: string[] };
    aspect?: { $eq?: string; $startsWith?: string; $in?: string[] };
  };
  /** Deduplicate by subject */
  distinctSubject?: boolean;
}

/**
 * Vector search result
 */
export interface VectorSearchResult {
  subject: string;
  aspect: string;
  score: number;
  distance: number;
}

/**
 * Vector delete request
 */
export interface VectorDeleteRequest {
  /** Embedding model name */
  model: string;
  /** Filter conditions (at least one field required) */
  filter: {
    subject?: { $eq?: string; $startsWith?: string };
    aspect?: { $eq?: string; $startsWith?: string };
  };
}

/**
 * Vector status response
 */
export interface VectorStatusResponse {
  byModel: Array<{ model: string; count: number }>;
  totalCount: number;
}

export interface VectorServiceOptions {
  /** CSS base URL for vector API */
  cssBaseUrl: string;
  /** Pod store for getting AI credentials */
  store: PodChatKitStore;
  /** Embedding service for generating vectors */
  embeddingService: EmbeddingService;
}

/**
 * VectorService - API Server 的向量服务
 *
 * 负责：
 * 1. 从 Pod 读取 AI 凭据
 * 2. 调用 EmbeddingService 生成向量
 * 3. 调用 CSS 的 /-/vector/* 端点存储/搜索向量
 */
export class VectorService {
  private readonly logger = getLoggerFor(this);
  private readonly cssBaseUrl: string;
  private readonly store: PodChatKitStore;
  private readonly embeddingService: EmbeddingService;

  public constructor(options: VectorServiceOptions) {
    this.cssBaseUrl = options.cssBaseUrl.replace(/\/$/, '');
    this.store = options.store;
    this.embeddingService = options.embeddingService;
  }

  /**
   * Upsert vectors to CSS vector store
   */
  public async upsert(
    request: VectorUpsertRequest,
    auth: AuthContext,
    accessToken: string,
  ): Promise<{ upserted: number; errors: string[]; took_ms: number }> {
    const startTime = Date.now();
    const userId = getWebId(auth) ?? getAccountId(auth) ?? 'anonymous';

    this.logger.info(`Vector upsert request from ${userId}, model: ${request.model}, count: ${request.vectors.length}`);

    // Convert subject+aspect to numeric IDs using hash
    const vectorsWithIds = request.vectors.map((v) => ({
      id: this.hashSubjectAspect(v.subject, v.aspect),
      vector: v.vector,
    }));

    // Call CSS vector API
    const response = await this.callCssVectorApi('upsert', accessToken, {
      model: request.model,
      vectors: vectorsWithIds,
    });

    return {
      upserted: response.upserted ?? 0,
      errors: response.errors ?? [],
      took_ms: Date.now() - startTime,
    };
  }

  /**
   * Search vectors in CSS vector store
   */
  public async search(
    request: VectorSearchRequest,
    auth: AuthContext,
    accessToken: string,
  ): Promise<{ results: VectorSearchResult[]; model: string; took_ms: number }> {
    const startTime = Date.now();
    const userId = getWebId(auth) ?? getAccountId(auth) ?? 'anonymous';

    this.logger.info(`Vector search request from ${userId}, model: ${request.model}`);

    let queryVector = request.vector;

    // If query text provided, generate embedding
    if (request.query && !queryVector) {
      const credential = await this.getAiCredential(auth);
      if (!credential) {
        throw new Error('No AI credential found for embedding generation');
      }
      queryVector = await this.embeddingService.embed(request.query, credential, request.model);
    }

    if (!queryVector) {
      throw new Error('Either query or vector must be provided');
    }

    // Call CSS vector API
    const response = await this.callCssVectorApi('search', accessToken, {
      model: request.model,
      vector: queryVector,
      limit: request.limit ?? 10,
      threshold: request.threshold,
      excludeIds: undefined, // TODO: implement filter to excludeIds conversion
    });

    // Map numeric IDs back to subject+aspect (requires metadata storage)
    // For now, return IDs as subjects (external API Server should maintain mapping)
    const results: VectorSearchResult[] = (response.results ?? []).map((r: any) => ({
      subject: String(r.id), // Placeholder - actual mapping should be done by caller
      aspect: '',
      score: r.score,
      distance: r.distance,
    }));

    return {
      results,
      model: request.model,
      took_ms: Date.now() - startTime,
    };
  }

  /**
   * Delete vectors from CSS vector store
   */
  public async delete(
    request: VectorDeleteRequest,
    auth: AuthContext,
    accessToken: string,
  ): Promise<{ deleted: number; errors: string[]; took_ms: number }> {
    const startTime = Date.now();
    const userId = getWebId(auth) ?? getAccountId(auth) ?? 'anonymous';

    this.logger.info(`Vector delete request from ${userId}, model: ${request.model}`);

    // Convert filter to IDs (simplified - actual implementation needs metadata lookup)
    const ids: number[] = [];

    if (request.filter.subject?.$eq && request.filter.aspect?.$eq) {
      ids.push(this.hashSubjectAspect(request.filter.subject.$eq, request.filter.aspect.$eq));
    }

    if (ids.length === 0) {
      return { deleted: 0, errors: ['No matching vectors found'], took_ms: Date.now() - startTime };
    }

    // Call CSS vector API
    const response = await this.callCssVectorApi('delete', accessToken, {
      model: request.model,
      ids,
    });

    return {
      deleted: response.deleted ?? 0,
      errors: response.errors ?? [],
      took_ms: Date.now() - startTime,
    };
  }

  /**
   * Get vector store status
   */
  public async status(accessToken: string): Promise<VectorStatusResponse> {
    const response = await this.callCssVectorApi('status', accessToken, undefined, 'GET');
    return {
      byModel: response.byModel ?? [],
      totalCount: response.totalCount ?? 0,
    };
  }

  /**
   * Generate embedding for text
   */
  public async embed(
    text: string,
    model: string,
    auth: AuthContext,
  ): Promise<number[]> {
    const credential = await this.getAiCredential(auth);

    if (!credential) {
      throw new Error('No AI credential found for embedding generation');
    }

    return this.embeddingService.embed(text, credential, model);
  }

  /**
   * Generate embeddings for multiple texts
   */
  public async embedBatch(
    texts: string[],
    model: string,
    auth: AuthContext,
  ): Promise<number[][]> {
    const credential = await this.getAiCredential(auth);

    if (!credential) {
      throw new Error('No AI credential found for embedding generation');
    }

    return this.embeddingService.embedBatch(texts, credential, model);
  }

  // ============================================
  // Private methods
  // ============================================

  /**
   * Create a StoreContext from AuthContext for Pod operations
   */
  private createStoreContext(auth: AuthContext): StoreContext {
    return {
      userId: getWebId(auth) ?? getAccountId(auth) ?? 'anonymous',
      auth,
    };
  }

  private async getAiCredential(auth: AuthContext): Promise<AiCredential | undefined> {
    const context = this.createStoreContext(auth);
    const config = await this.store.getAiConfig(context);
    if (!config) {
      return undefined;
    }
    return {
      provider: config.providerId,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      proxyUrl: config.proxyUrl,
    };
  }

  private async callCssVectorApi(
    action: string,
    accessToken: string,
    body?: unknown,
    method: 'GET' | 'POST' | 'DELETE' = 'POST',
  ): Promise<any> {
    const url = `${this.cssBaseUrl}/-/vector/${action}`;

    const options: RequestInit = {
      method,
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    };

    if (body && method !== 'GET') {
      options.body = JSON.stringify(body);
    }

    this.logger.debug(`Calling CSS vector API: ${method} ${url}`);

    const response = await fetch(url, options);

    if (!response.ok) {
      const errorText = await response.text();
      this.logger.error(`CSS vector API error: ${response.status} ${errorText}`);
      throw new Error(`CSS vector API error: ${response.status} ${response.statusText}`);
    }

    return response.json();
  }

  /**
   * Hash subject + aspect to numeric ID
   * Uses FNV-1a hash for good distribution
   */
  private hashSubjectAspect(subject: string, aspect: string): number {
    const str = `${subject}|${aspect}`;
    let hash = 2166136261; // FNV offset basis
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = Math.imul(hash, 16777619); // FNV prime
    }
    return Math.abs(hash);
  }
}
