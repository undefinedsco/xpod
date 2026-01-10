import { getLoggerFor } from 'global-logger-factory';
import { drizzle, eq } from 'drizzle-solid';
import { randomBytes } from 'crypto';
import type { AuthContext } from '../auth/AuthContext';
import { getWebId, getAccountId, isSolidAuth } from '../auth/AuthContext';
import type { EmbeddingService } from '../../embedding/EmbeddingService';
import type { AiCredential } from '../../embedding/types';
import type { ClientCredentialsStore } from '../auth/ClientCredentialsAuthenticator';
import { Session } from '@inrupt/solid-client-authn-node';

import {
  AIConfig,
  VectorStore,
  IndexedFile,
  Model,
  Provider,
  VectorStoreStatus,
  ChunkingStrategy,
  FileIndexStatus,
  MigrationStatus,
} from '../../embedding/schema/tables';
import { Credential } from '../../credential/schema/tables';
import { ServiceType, CredentialStatus } from '../../credential/schema/types';

const schema = {
  aiConfig: AIConfig,
  vectorStore: VectorStore,
  indexedFile: IndexedFile,
  model: Model,
  provider: Provider,
  credential: Credential,
};

// ============================================
// Types - OpenAI Compatible
// ============================================

/**
 * 创建 Vector Store 请求
 */
export interface CreateVectorStoreRequest {
  /** 知识库名称 */
  name?: string;
  /** Container URL */
  url: string;
  /** Chunking 策略 */
  chunking_strategy?: 'auto' | 'static';
  /** 元数据 */
  metadata?: Record<string, string>;
}

/**
 * 修改 Vector Store 请求
 */
export interface ModifyVectorStoreRequest {
  name?: string;
  chunking_strategy?: 'auto' | 'static';
  metadata?: Record<string, string>;
}

/**
 * Vector Store 对象（OpenAI 兼容格式）
 */
export interface VectorStoreObject {
  id: string;
  object: 'vector_store';
  created_at: number;
  name: string;
  status: 'in_progress' | 'completed' | 'expired';
  usage_bytes: number;
  file_counts: {
    in_progress: number;
    completed: number;
    failed: number;
    cancelled: number;
    total: number;
  };
  last_active_at: number | null;
  metadata: Record<string, string>;
  // Xpod 扩展字段
  url: string;
  chunking_strategy: string;
}

/**
 * Pod AI 配置
 */
export interface PodAIConfig {
  embeddingModel: string;
  migrationStatus: 'idle' | 'in_progress' | 'completed' | 'failed';
  previousModel?: string;
  migrationProgress?: number;
}

/**
 * 搜索请求
 */
export interface SearchRequest {
  query: string | string[];
  max_num_results?: number;
  filters?: Record<string, any>;
  ranking_options?: {
    ranker?: string;
    score_threshold?: number;
  };
  rewrite_query?: boolean;
}

/**
 * 搜索结果
 */
export interface SearchResult {
  file_id: string;
  file_url: string;
  filename: string;
  score: number;
  attributes: Record<string, any>;
  content: Array<{ type: 'text'; text: string }>;
}

export interface VectorStoreServiceOptions {
  /** CSS base URL */
  cssBaseUrl: string;
  /** Token endpoint for login */
  tokenEndpoint: string;
  /** API Key store */
  apiKeyStore: ClientCredentialsStore;
  /** Embedding service */
  embeddingService: EmbeddingService;
  /** Webhook URL for receiving notifications (optional) */
  webhookUrl?: string;
}

/**
 * VectorStoreService - 知识库管理服务
 *
 * 提供 OpenAI 兼容的 Vector Store API
 */
export class VectorStoreService {
  private readonly logger = getLoggerFor(this);
  private readonly cssBaseUrl: string;
  private readonly tokenEndpoint: string;
  private readonly apiKeyStore: ClientCredentialsStore;
  private readonly embeddingService: EmbeddingService;
  private readonly webhookUrl?: string;

  public constructor(options: VectorStoreServiceOptions) {
    this.cssBaseUrl = options.cssBaseUrl.replace(/\/$/, '');
    this.tokenEndpoint = options.tokenEndpoint;
    this.apiKeyStore = options.apiKeyStore;
    this.embeddingService = options.embeddingService;
    this.webhookUrl = options.webhookUrl;
  }

  // ============================================
  // Vector Store CRUD
  // ============================================

  /**
   * 创建 Vector Store（配置文件夹为知识库）
   */
  public async createVectorStore(
    request: CreateVectorStoreRequest,
    auth: AuthContext,
    accessToken?: string,
  ): Promise<VectorStoreObject> {
    const db = await this.getPodDb(auth);
    if (!db) {
      throw new Error('Failed to authenticate with Pod');
    }

    // 生成 ID
    const id = this.generateId();
    const now = new Date();
    const containerUri = request.url;

    // 插入记录（不再存储 model，model 从全局配置获取）
    await db.insert(VectorStore).values({
      id,
      name: request.name || this.extractContainerName(containerUri),
      container: containerUri,
      chunkingStrategy: request.chunking_strategy || ChunkingStrategy.AUTO,
      status: VectorStoreStatus.COMPLETED,
      createdAt: now,
      lastActiveAt: now,
    });

    this.logger.info(`Created vector store ${id} for container ${containerUri}`);

    // 尝试注册 webhook 订阅（如果配置了 webhookUrl）
    if (this.webhookUrl && accessToken) {
      try {
        await this.subscribeToContainer(containerUri, accessToken);
        this.logger.info(`Subscribed to container ${containerUri} for webhook notifications`);
      } catch (error) {
        // 订阅失败不影响 VectorStore 创建，只记录警告
        this.logger.warn(`Failed to subscribe to container ${containerUri}: ${error}`);
      }
    }

    return this.buildVectorStoreObject(id, {
      name: request.name || this.extractContainerName(containerUri),
      containerUrl: containerUri,
      chunkingStrategy: request.chunking_strategy || 'auto',
      status: 'completed',
      createdAt: now,
      lastActiveAt: now,
    });
  }

  /**
   * 列出所有 Vector Store
   */
  public async listVectorStores(
    auth: AuthContext,
    options?: { limit?: number; order?: 'asc' | 'desc'; after?: string; before?: string },
  ): Promise<{ object: 'list'; data: VectorStoreObject[]; has_more: boolean }> {
    const db = await this.getPodDb(auth);
    if (!db) {
      throw new Error('Failed to authenticate with Pod');
    }

    const stores = await db.select().from(VectorStore);

    // 排序
    const order = options?.order || 'desc';
    stores.sort((a, b) => {
      const aTime = a.createdAt?.getTime() || 0;
      const bTime = b.createdAt?.getTime() || 0;
      return order === 'desc' ? bTime - aTime : aTime - bTime;
    });

    // 分页
    const limit = options?.limit || 20;
    const data = stores.slice(0, limit).map(store => this.buildVectorStoreObject(store.id, {
      name: store.name || '',
      containerUrl: store.container || '',
      chunkingStrategy: store.chunkingStrategy || 'auto',
      status: (store.status as any) || 'completed',
      createdAt: store.createdAt || new Date(),
      lastActiveAt: store.lastActiveAt || null,
    }));

    return {
      object: 'list',
      data,
      has_more: stores.length > limit,
    };
  }

  /**
   * 获取单个 Vector Store
   */
  public async getVectorStore(id: string, auth: AuthContext): Promise<VectorStoreObject> {
    const db = await this.getPodDb(auth);
    if (!db) {
      throw new Error('Failed to authenticate with Pod');
    }

    const stores = await db.select().from(VectorStore).where(eq(VectorStore.id, id));
    if (stores.length === 0) {
      throw new Error(`Vector store ${id} not found`);
    }

    const store = stores[0];

    // 获取 file_counts（基于 Container 前缀匹配）
    const fileCounts = await this.getFileCounts(store.container || '', auth);

    return this.buildVectorStoreObject(store.id, {
      name: store.name || '',
      containerUrl: store.container || '',
      chunkingStrategy: store.chunkingStrategy || 'auto',
      status: (store.status as any) || 'completed',
      createdAt: store.createdAt || new Date(),
      lastActiveAt: store.lastActiveAt || null,
      fileCounts,
    });
  }

  /**
   * 修改 Vector Store
   */
  public async modifyVectorStore(
    id: string,
    request: ModifyVectorStoreRequest,
    auth: AuthContext,
  ): Promise<VectorStoreObject> {
    const db = await this.getPodDb(auth);
    if (!db) {
      throw new Error('Failed to authenticate with Pod');
    }

    // 构建更新数据（不再支持修改 model，model 是全局配置）
    const updates: Partial<typeof VectorStore.$inferInsert> = {};
    if (request.name !== undefined) updates.name = request.name;
    if (request.chunking_strategy !== undefined) updates.chunkingStrategy = request.chunking_strategy;

    await db.update(VectorStore).set(updates).where(eq(VectorStore.id, id));

    return this.getVectorStore(id, auth);
  }

  /**
   * 删除 Vector Store
   */
  public async deleteVectorStore(
    id: string,
    auth: AuthContext,
  ): Promise<{ id: string; object: 'vector_store.deleted'; deleted: boolean }> {
    const db = await this.getPodDb(auth);
    if (!db) {
      throw new Error('Failed to authenticate with Pod');
    }

    await db.delete(VectorStore).where(eq(VectorStore.id, id));

    this.logger.info(`Deleted vector store ${id}`);

    return {
      id,
      object: 'vector_store.deleted',
      deleted: true,
    };
  }

  // ============================================
  // File Index Management (for webhook)
  // ============================================

  /**
   * 索引文件（由 webhook 调用）
   *
   * @param vectorStoreId Vector Store ID
   * @param fileUrl 文件 URL
   * @param auth 认证上下文
   * @param accessToken 访问令牌
   */
  public async indexFile(
    fileUrl: string,
    auth: AuthContext,
    accessToken: string,
  ): Promise<{ id: string; status: string; vectorId: number }> {
    const db = await this.getPodDb(auth);
    if (!db) {
      throw new Error('Failed to authenticate with Pod');
    }

    // 获取全局 AI 配置（embedding model）
    const aiConfig = await this.getAIConfig(auth);
    if (!aiConfig) {
      throw new Error('No AI configuration found. Please configure an embedding model first.');
    }

    // 查找最近的父级 VectorStore 获取分块策略
    const chunkingStrategy = await this.getChunkingStrategyForFile(fileUrl, auth);

    // 检查文件是否已索引
    const existingFiles = await db.select().from(IndexedFile).where(
      eq(IndexedFile.fileUrl, fileUrl),
    );

    const vectorId = this.hashSubjectAspect(fileUrl, 'content');
    let fileIndexId: string;

    if (existingFiles.length > 0) {
      // 文件已存在，更新状态
      fileIndexId = existingFiles[0].id;
      await db.update(IndexedFile).set({
        status: FileIndexStatus.IN_PROGRESS,
        chunkingStrategy,
        indexedAt: new Date(),
      }).where(eq(IndexedFile.id, fileIndexId));
    } else {
      // 创建新的索引记录
      fileIndexId = `idx_${randomBytes(8).toString('hex')}`;
      await db.insert(IndexedFile).values({
        id: fileIndexId,
        fileUrl,
        vectorId,
        chunkingStrategy,
        status: FileIndexStatus.IN_PROGRESS,
        usageBytes: 0,
        indexedAt: new Date(),
      });
    }

    try {
      // 获取 AI credential
      const credential = await this.getAiCredential(auth);
      if (!credential) {
        throw new Error('No AI credential found');
      }

      // 读取文件内容
      const content = await this.fetchResourceContent(fileUrl, accessToken);
      if (!content || content.trim().length === 0) {
        throw new Error(`File ${fileUrl} has no indexable content`);
      }

      // 生成 embedding（使用全局 model）
      const embedding = await this.embeddingService.embed(content, credential, aiConfig.embeddingModel);

      // 存储向量
      await this.upsertVector(aiConfig.embeddingModel, vectorId, embedding, accessToken);

      // 更新索引记录为 completed
      await db.update(IndexedFile).set({
        status: FileIndexStatus.COMPLETED,
        usageBytes: content.length,
        lastError: null,
      }).where(eq(IndexedFile.id, fileIndexId));

      this.logger.info(`Indexed file ${fileUrl} with model ${aiConfig.embeddingModel}`);

      return { id: fileIndexId, status: 'completed', vectorId };
    } catch (error) {
      // 更新索引记录为 failed
      const errorMsg = error instanceof Error ? error.message : String(error);
      await db.update(IndexedFile).set({
        status: FileIndexStatus.FAILED,
        lastError: errorMsg,
      }).where(eq(IndexedFile.id, fileIndexId));

      this.logger.error(`Failed to index file ${fileUrl}: ${errorMsg}`);
      throw error;
    }
  }

  /**
   * 获取文件应使用的分块策略（查找最近的父级 VectorStore）
   */
  private async getChunkingStrategyForFile(fileUrl: string, auth: AuthContext): Promise<string> {
    const db = await this.getPodDb(auth);
    if (!db) return ChunkingStrategy.AUTO;

    // 获取所有 VectorStore
    const allStores = await db.select().from(VectorStore);

    // 找到所有是 fileUrl 前缀的 VectorStore
    const matchedStores = allStores.filter(store => {
      if (!store.container) return false;
      const containerUrl = store.container.endsWith('/') ? store.container : store.container + '/';
      return fileUrl.startsWith(containerUrl);
    });

    if (matchedStores.length === 0) {
      return ChunkingStrategy.AUTO;
    }

    // 找最长前缀（最近的父级）
    matchedStores.sort((a, b) => (b.container?.length || 0) - (a.container?.length || 0));
    return matchedStores[0].chunkingStrategy || ChunkingStrategy.AUTO;
  }

  /**
   * 删除文件索引（由 webhook 调用）
   */
  public async removeFileIndex(
    fileUrl: string,
    auth: AuthContext,
    accessToken: string,
  ): Promise<{ deleted: boolean }> {
    const db = await this.getPodDb(auth);
    if (!db) {
      throw new Error('Failed to authenticate with Pod');
    }

    // 获取全局 AI 配置
    const aiConfig = await this.getAIConfig(auth);
    if (!aiConfig) {
      this.logger.warn(`No AI config found, cannot delete vector for ${fileUrl}`);
      return { deleted: false };
    }

    // 查找文件索引记录
    const files = await db.select().from(IndexedFile).where(
      eq(IndexedFile.fileUrl, fileUrl),
    );

    if (files.length === 0) {
      this.logger.warn(`File index record not found for ${fileUrl}`);
      return { deleted: false };
    }

    const fileRecord = files[0];

    // 从向量存储中删除
    if (fileRecord.vectorId) {
      await this.deleteVector(aiConfig.embeddingModel, fileRecord.vectorId, accessToken);
    }

    // 删除索引记录
    await db.delete(IndexedFile).where(eq(IndexedFile.id, fileRecord.id));

    this.logger.info(`Removed file index ${fileUrl}`);
    return { deleted: true };
  }

  /**
   * 获取 Container 下的 file_counts 统计（基于 fileUrl 前缀匹配）
   */
  public async getFileCounts(
    containerUrl: string,
    auth: AuthContext,
  ): Promise<{ in_progress: number; completed: number; failed: number; cancelled: number; total: number }> {
    const db = await this.getPodDb(auth);
    if (!db) {
      return { in_progress: 0, completed: 0, failed: 0, cancelled: 0, total: 0 };
    }

    // 获取所有索引文件，过滤属于该 Container 的
    const allFiles = await db.select().from(IndexedFile);
    const containerPrefix = containerUrl.endsWith('/') ? containerUrl : containerUrl + '/';
    const files = allFiles.filter(f => f.fileUrl?.startsWith(containerPrefix));

    const counts = {
      in_progress: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      total: files.length,
    };

    for (const file of files) {
      switch (file.status) {
        case FileIndexStatus.IN_PROGRESS:
          counts.in_progress++;
          break;
        case FileIndexStatus.COMPLETED:
          counts.completed++;
          break;
        case FileIndexStatus.FAILED:
          counts.failed++;
          break;
        case FileIndexStatus.CANCELLED:
          counts.cancelled++;
          break;
      }
    }

    return counts;
  }

  /**
   * 通过 vectorId 查找文件 URL（供 search 使用）
   * 注意：文件只索引一份，用 vectorId 即可查找
   */
  public async getFileUrlByVectorId(
    vectorId: number,
    auth: AuthContext,
  ): Promise<string | null> {
    const db = await this.getPodDb(auth);
    if (!db) return null;

    const files = await db.select().from(IndexedFile).where(
      eq(IndexedFile.vectorId, vectorId),
    );

    return files.length > 0 ? files[0].fileUrl : null;
  }

  /**
   * 根据 Container URL 查找 VectorStore
   */
  public async findVectorStoreByContainer(
    containerUrl: string,
    auth: AuthContext,
  ): Promise<VectorStoreObject | null> {
    const db = await this.getPodDb(auth);
    if (!db) return null;

    const stores = await db.select().from(VectorStore).where(
      eq(VectorStore.container, containerUrl),
    );

    if (stores.length === 0) return null;

    const store = stores[0];
    return this.buildVectorStoreObject(store.id, {
      name: store.name || '',
      containerUrl: store.container || '',
      chunkingStrategy: store.chunkingStrategy || 'auto',
      status: (store.status as any) || 'completed',
      createdAt: store.createdAt || new Date(),
      lastActiveAt: store.lastActiveAt || null,
    });
  }

  /**
   * 根据文件 URL 查找所有匹配的 VectorStore（包括父级容器）
   *
   * 例如：文件 https://alice.pod/A/B/c.txt 会匹配：
   * - https://alice.pod/A/B/  (直接父级)
   * - https://alice.pod/A/    (祖先级)
   * - https://alice.pod/      (Pod 根)
   *
   * 这样文件可以被索引到多个知识库中
   */
  public async findVectorStoresByFileUrl(
    fileUrl: string,
    auth: AuthContext,
  ): Promise<VectorStoreObject[]> {
    const db = await this.getPodDb(auth);
    if (!db) return [];

    // 获取所有 VectorStore
    const allStores = await db.select().from(VectorStore);

    // 过滤出 container 是 fileUrl 前缀的 VectorStore
    const matchedStores = allStores.filter(store => {
      if (!store.container) return false;
      // 确保 container URL 以 / 结尾
      const containerUrl = store.container.endsWith('/') ? store.container : store.container + '/';
      return fileUrl.startsWith(containerUrl);
    });

    // 转换为 VectorStoreObject
    return matchedStores.map(store => this.buildVectorStoreObject(store.id, {
      name: store.name || '',
      containerUrl: store.container || '',
      chunkingStrategy: store.chunkingStrategy || 'auto',
      status: (store.status as any) || 'completed',
      createdAt: store.createdAt || new Date(),
      lastActiveAt: store.lastActiveAt || null,
    }));
  }

  // ============================================
  // Search
  // ============================================

  /**
   * 搜索 Vector Store
   */
  public async search(
    vectorStoreId: string,
    request: SearchRequest,
    auth: AuthContext,
    accessToken: string,
  ): Promise<{ object: 'vector_store.search_results.page'; search_query: string; data: SearchResult[]; has_more: boolean }> {
    const store = await this.getVectorStore(vectorStoreId, auth);

    // 获取 AI credential
    const credential = await this.getAiCredential(auth);
    if (!credential) {
      throw new Error('No AI credential found');
    }

    // 获取全局 AI 配置中的 embedding model
    const aiConfig = await this.getAIConfig(auth);
    if (!aiConfig?.embeddingModel) {
      throw new Error('No embedding model configured. Please set up AI configuration first.');
    }

    const queryText = Array.isArray(request.query) ? request.query.join(' ') : request.query;

    // 生成 query embedding（使用全局模型）
    const queryEmbedding = await this.embeddingService.embed(queryText, credential, aiConfig.embeddingModel);

    // 调用 CSS vector search，使用 subjectPrefix 过滤只搜索该 VectorStore 的文件
    const limit = request.max_num_results || 10;
    const results = await this.searchVectors(aiConfig.embeddingModel, queryEmbedding, limit, accessToken, {
      subjectPrefix: store.url,  // Container URL 作为 subject 前缀
    });

    // 构建搜索结果，使用 vectorId -> fileUrl 映射
    const searchResults: SearchResult[] = [];
    for (const r of results) {
      const vectorId = typeof r.id === 'number' ? r.id : parseInt(String(r.id), 10);
      const fileUrl = await this.getFileUrlByVectorId(vectorId, auth);

      searchResults.push({
        file_id: String(r.id),
        file_url: fileUrl || '',
        filename: fileUrl ? this.extractFilename(fileUrl) : '',
        score: r.score,
        attributes: {},
        content: [], // TODO: 可选返回内容片段
      });
    }

    return {
      object: 'vector_store.search_results.page',
      search_query: queryText,
      data: searchResults,
      has_more: false,
    };
  }

  // ============================================
  // Private Methods
  // ============================================

  private generateId(): string {
    return `vs_${randomBytes(12).toString('hex')}`;
  }

  /**
   * Hash subject + aspect 为向量 ID（供 webhook 索引使用）
   */
  public hashSubjectAspect(subject: string, aspect: string): number {
    const str = `${subject}|${aspect}`;
    let hash = 2166136261;
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return Math.abs(hash);
  }

  private extractContainerName(url: string): string {
    const parts = url.replace(/\/$/, '').split('/');
    return parts[parts.length - 1] || 'Unnamed';
  }

  private extractFilename(url: string): string {
    const parts = url.split('/');
    return parts[parts.length - 1] || '';
  }

  private extractModelId(uri: string): string {
    const hashIndex = uri.lastIndexOf('#');
    if (hashIndex !== -1) {
      return uri.slice(hashIndex + 1);
    }
    return uri;
  }

  private getPodBaseUrl(webId: string): string {
    const url = new URL(webId);
    url.hash = '';
    let path = url.pathname;
    if (path.endsWith('/profile/card')) {
      path = path.slice(0, -'/profile/card'.length);
    }
    if (!path.endsWith('/')) {
      path = path + '/';
    }
    return `${url.origin}${path}`;
  }

  private buildVectorStoreObject(
    id: string,
    data: {
      name: string;
      containerUrl: string;
      chunkingStrategy: string;
      status: 'in_progress' | 'completed' | 'expired';
      createdAt: Date;
      lastActiveAt: Date | null;
      fileCounts?: { in_progress: number; completed: number; failed: number; cancelled: number; total: number };
      usageBytes?: number;
    },
  ): VectorStoreObject {
    return {
      id,
      object: 'vector_store',
      created_at: Math.floor(data.createdAt.getTime() / 1000),
      name: data.name,
      status: data.status,
      usage_bytes: data.usageBytes || 0,
      file_counts: data.fileCounts || {
        in_progress: 0,
        completed: 0,
        failed: 0,
        cancelled: 0,
        total: 0,
      },
      last_active_at: data.lastActiveAt ? Math.floor(data.lastActiveAt.getTime() / 1000) : null,
      metadata: {},
      url: data.containerUrl,
      chunking_strategy: data.chunkingStrategy,
    };
  }

  private async getPodDb(auth: AuthContext) {
    if (!isSolidAuth(auth) || !auth.clientId) {
      this.logger.debug('No clientId in auth context');
      return null;
    }

    const creds = await this.apiKeyStore.findByClientId(auth.clientId);
    if (!creds) {
      this.logger.warn(`No credentials found for client ${auth.clientId}`);
      return null;
    }

    const session = new Session();
    try {
      await session.login({
        oidcIssuer: new URL(this.tokenEndpoint).origin,
        clientId: creds.clientId,
        clientSecret: creds.clientSecret,
      });

      if (!session.info.isLoggedIn || !session.info.webId) {
        throw new Error('Login failed');
      }

      return drizzle({ fetch: session.fetch, info: { webId: session.info.webId, isLoggedIn: true } } as any, { schema });
    } catch (error) {
      this.logger.error(`Failed to login: ${error}`);
      return null;
    }
  }

  private async getAiCredential(auth: AuthContext): Promise<AiCredential | undefined> {
    const db = await this.getPodDb(auth);
    if (!db) return undefined;

    try {
      const credentials = await db.select().from(Credential).where(
        eq(Credential.service, ServiceType.AI),
      );

      const activeCred = credentials.find(c => c.status === CredentialStatus.ACTIVE);
      if (!activeCred || !activeCred.apiKey) return undefined;

      // 获取 provider 信息
      let baseUrl: string | undefined;
      let proxyUrl: string | undefined;

      if (activeCred.provider) {
        const providers = await db.select().from(Provider);
        const provider = providers.find(p => activeCred.provider?.includes(p.id));
        if (provider) {
          baseUrl = provider.baseUrl || undefined;
          proxyUrl = provider.proxyUrl || undefined;
        }
      }

      return {
        provider: activeCred.id,
        apiKey: activeCred.apiKey,
        baseUrl: activeCred.baseUrl || baseUrl,
        proxyUrl,
      };
    } catch (error) {
      this.logger.error(`Failed to get AI credential: ${error}`);
      return undefined;
    }
  }

  /**
   * 获取 Pod 级别的 AI 配置（全局 embedding model）
   */
  public async getAIConfig(auth: AuthContext): Promise<PodAIConfig | null> {
    const db = await this.getPodDb(auth);
    if (!db) return null;

    try {
      const configs = await db.select().from(AIConfig);
      const config = configs.find(c => c.id === 'config');

      if (!config || !config.embeddingModel) {
        // 如果没有配置，尝试使用默认模型
        const models = await db.select().from(Model);
        const defaultModel = models.find(m => m.modelType === 'embedding') || models[0];
        if (defaultModel) {
          return {
            embeddingModel: defaultModel.id,
            migrationStatus: 'idle',
          };
        }
        return null;
      }

      return {
        embeddingModel: this.extractModelId(config.embeddingModel),
        migrationStatus: (config.migrationStatus as any) || 'idle',
        previousModel: config.previousModel ? this.extractModelId(config.previousModel) : undefined,
        migrationProgress: config.migrationProgress || undefined,
      };
    } catch (error) {
      this.logger.error(`Failed to get AI config: ${error}`);
      return null;
    }
  }

  /**
   * 设置全局 embedding model
   * 如果更换了模型，自动触发迁移（后台重新索引所有文件）
   */
  public async setEmbeddingModel(
    newModel: string,
    auth: AuthContext,
    accessToken: string,
  ): Promise<{ success: boolean; migrationTriggered: boolean; message: string }> {
    const db = await this.getPodDb(auth);
    if (!db) {
      throw new Error('Failed to authenticate with Pod');
    }

    const currentConfig = await this.getAIConfig(auth);
    const currentModel = currentConfig?.embeddingModel;

    // 检查模型是否有变化
    const modelChanged = currentModel && currentModel !== newModel;

    const webId = getWebId(auth) ?? getAccountId(auth) ?? '';
    const podBaseUrl = this.getPodBaseUrl(webId);
    const modelUri = `${podBaseUrl}settings/ai/models.ttl#${newModel}`;

    try {
      // 检查配置是否已存在
      const configs = await db.select().from(AIConfig);
      const existingConfig = configs.find(c => c.id === 'config');

      if (existingConfig) {
        // 更新现有配置
        await db.update(AIConfig).set({
          embeddingModel: modelUri,
          previousModel: modelChanged ? `${podBaseUrl}settings/ai/models.ttl#${currentModel}` : existingConfig.previousModel,
          migrationStatus: modelChanged ? MigrationStatus.IN_PROGRESS : existingConfig.migrationStatus,
          migrationProgress: modelChanged ? 0 : existingConfig.migrationProgress,
          updatedAt: new Date(),
        }).where(eq(AIConfig.id, 'config'));
      } else {
        // 创建新配置
        await db.insert(AIConfig).values({
          id: 'config',
          embeddingModel: modelUri,
          migrationStatus: MigrationStatus.IDLE,
          migrationProgress: 0,
          updatedAt: new Date(),
        });
      }

      this.logger.info(`Set embedding model to ${newModel}`);

      // 如果模型变化，在后台启动迁移
      if (modelChanged) {
        this.logger.info(`Model changed from ${currentModel} to ${newModel}, triggering migration`);
        // 异步执行迁移，不阻塞响应
        this.startMigration(auth, accessToken).catch(error => {
          this.logger.error(`Migration failed: ${error}`);
        });
      }

      return {
        success: true,
        migrationTriggered: modelChanged === true,
        message: modelChanged
          ? `Model updated to ${newModel}. Migration started to re-index all files.`
          : `Model set to ${newModel}.`,
      };
    } catch (error) {
      this.logger.error(`Failed to set embedding model: ${error}`);
      throw error;
    }
  }

  /**
   * 开始迁移：重新索引所有文件
   */
  private async startMigration(auth: AuthContext, accessToken: string): Promise<void> {
    const db = await this.getPodDb(auth);
    if (!db) return;

    try {
      // 获取所有已索引的文件
      const allFiles = await db.select().from(IndexedFile);
      const totalFiles = allFiles.length;

      if (totalFiles === 0) {
        // 无文件需要迁移
        await db.update(AIConfig).set({
          migrationStatus: MigrationStatus.COMPLETED,
          migrationProgress: 100,
          updatedAt: new Date(),
        }).where(eq(AIConfig.id, 'config'));
        return;
      }

      this.logger.info(`Starting migration for ${totalFiles} files`);

      let completedFiles = 0;
      let failedFiles = 0;

      for (const file of allFiles) {
        try {
          // 重新索引每个文件
          await this.indexFile(file.fileUrl, auth, accessToken);
          completedFiles++;
        } catch (error) {
          failedFiles++;
          this.logger.error(`Failed to re-index ${file.fileUrl}: ${error}`);
        }

        // 更新迁移进度
        const progress = Math.round(((completedFiles + failedFiles) / totalFiles) * 100);
        await db.update(AIConfig).set({
          migrationProgress: progress,
          updatedAt: new Date(),
        }).where(eq(AIConfig.id, 'config'));
      }

      // 标记迁移完成
      const finalStatus = failedFiles === 0 ? MigrationStatus.COMPLETED : MigrationStatus.FAILED;
      await db.update(AIConfig).set({
        migrationStatus: finalStatus,
        migrationProgress: 100,
        updatedAt: new Date(),
      }).where(eq(AIConfig.id, 'config'));

      this.logger.info(`Migration completed: ${completedFiles} success, ${failedFiles} failed`);
    } catch (error) {
      this.logger.error(`Migration error: ${error}`);
      await db.update(AIConfig).set({
        migrationStatus: MigrationStatus.FAILED,
        updatedAt: new Date(),
      }).where(eq(AIConfig.id, 'config'));
    }
  }

  /**
   * 获取资源内容（供 webhook 索引使用）
   */
  public async fetchResourceContent(url: string, accessToken: string): Promise<string> {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'text/turtle, application/ld+json, text/plain, text/markdown, text/html, */*',
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch ${url}: ${response.status}`);
    }

    const contentType = response.headers.get('Content-Type') || '';
    const body = await response.text();
    return this.extractText(body, contentType);
  }

  private extractText(body: string, contentType: string): string {
    const ct = contentType.toLowerCase();

    if (ct.includes('text/turtle') || ct.includes('application/n-triples')) {
      return this.extractTextFromTurtle(body);
    }
    if (ct.includes('application/ld+json') || ct.includes('application/json')) {
      return this.extractTextFromJsonLd(body);
    }
    if (ct.includes('text/html')) {
      return this.extractTextFromHtml(body);
    }
    return body;
  }

  private extractTextFromTurtle(turtle: string): string {
    const literals: string[] = [];
    const tripleQuoteRegex = /"""([^]*?)"""/g;
    const singleQuoteRegex = /"([^"\\]*(?:\\.[^"\\]*)*)"/g;

    let match;
    while ((match = tripleQuoteRegex.exec(turtle)) !== null) {
      if (match[1].trim().length > 0) literals.push(match[1].trim());
    }

    const withoutTriple = turtle.replace(/"""[^]*?"""/g, '');
    while ((match = singleQuoteRegex.exec(withoutTriple)) !== null) {
      const value = match[1].trim();
      if (value.length > 3 && !value.startsWith('http') && !value.startsWith('urn:')) {
        literals.push(value);
      }
    }
    return literals.join('\n');
  }

  private extractTextFromJsonLd(jsonStr: string): string {
    try {
      const json = JSON.parse(jsonStr);
      const texts: string[] = [];
      const extract = (obj: any): void => {
        if (typeof obj === 'string' && obj.length > 3 && !obj.startsWith('http')) {
          texts.push(obj);
        } else if (Array.isArray(obj)) {
          obj.forEach(extract);
        } else if (obj && typeof obj === 'object') {
          for (const [key, value] of Object.entries(obj)) {
            if (!key.startsWith('@')) extract(value);
          }
        }
      };
      extract(json);
      return texts.join('\n');
    } catch {
      return jsonStr;
    }
  }

  private extractTextFromHtml(html: string): string {
    let text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
    text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
    text = text.replace(/<[^>]+>/g, ' ');
    text = text.replace(/\s+/g, ' ').trim();
    return text;
  }

  /**
   * Upsert 向量到 CSS（供 webhook 索引使用）
   */
  public async upsertVector(model: string, id: number, vector: number[], accessToken: string): Promise<void> {
    const url = `${this.cssBaseUrl}/-/vector/upsert`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ model, vectors: [{ id, vector }] }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Vector upsert failed: ${response.status} ${errorText}`);
    }
  }

  /**
   * 删除向量（供 webhook 索引使用）
   */
  public async deleteVector(model: string, id: number, accessToken: string): Promise<void> {
    const url = `${this.cssBaseUrl}/-/vector/delete`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ model, ids: [id] }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Vector delete failed: ${response.status} ${errorText}`);
    }
  }

  private async searchVectors(
    model: string,
    vector: number[],
    limit: number,
    accessToken: string,
    options?: { subjectPrefix?: string },
  ): Promise<any[]> {
    const url = `${this.cssBaseUrl}/-/vector/search`;
    
    const body: Record<string, any> = { model, vector, limit };
    
    // 添加 subject 前缀过滤（限定搜索范围到特定 Container）
    if (options?.subjectPrefix) {
      body.filter = {
        subject: { $startsWith: options.subjectPrefix },
      };
    }
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`Vector search failed: ${response.status}`);
    }

    const data = await response.json() as { results?: any[] };
    return data.results || [];
  }

  // ============================================
  // Webhook Subscription
  // ============================================

  /**
   * 订阅 Container 的变更通知（WebhookChannel2023）
   *
   * @param containerUrl Container URL
   * @param accessToken 访问令牌
   */
  private async subscribeToContainer(containerUrl: string, accessToken: string): Promise<void> {
    if (!this.webhookUrl) {
      throw new Error('Webhook URL not configured');
    }

    // 1. 发现订阅端点
    const subscriptionEndpoint = await this.discoverNotificationEndpoint(containerUrl, accessToken);
    if (!subscriptionEndpoint) {
      throw new Error(`No notification endpoint found for ${containerUrl}`);
    }

    // 2. 创建 webhook 订阅
    const subscriptionRequest = {
      '@context': ['https://www.w3.org/ns/solid/notification/v1'],
      type: 'WebhookChannel2023',
      topic: containerUrl,
      sendTo: this.webhookUrl,
    };

    const response = await fetch(subscriptionEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/ld+json',
        Accept: 'application/ld+json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(subscriptionRequest),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Subscription failed: ${response.status} ${errorText}`);
    }

    const result = await response.json();
    this.logger.info(`Created webhook subscription: ${JSON.stringify(result)}`);
  }

  /**
   * 发现 Solid Notification 端点
   *
   * 通过 HEAD 请求获取 Link header 中的 describedby，然后获取订阅端点
   */
  private async discoverNotificationEndpoint(resourceUrl: string, accessToken: string): Promise<string | null> {
    // 方法 1：直接使用已知的 CSS 端点格式
    // CSS 的 webhook 订阅端点通常是 /.notifications/WebhookChannel2023/
    const url = new URL(resourceUrl);
    const webhookEndpoint = `${url.origin}/.notifications/WebhookChannel2023/`;

    // 验证端点是否存在
    try {
      const response = await fetch(webhookEndpoint, {
        method: 'GET',
        headers: {
          Accept: 'application/ld+json',
          Authorization: `Bearer ${accessToken}`,
        },
      });

      if (response.ok) {
        return webhookEndpoint;
      }
    } catch {
      // 忽略错误，尝试其他方法
    }

    // 方法 2：通过 describedby Link header 发现
    try {
      const headResponse = await fetch(resourceUrl, {
        method: 'HEAD',
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      const linkHeader = headResponse.headers.get('Link');
      if (linkHeader) {
        // 解析 Link header 找 describedby
        const describedBy = this.parseLinkHeader(linkHeader, 'describedby');
        if (describedBy) {
          // 获取 describedby 资源，解析通知端点
          const descResponse = await fetch(describedBy, {
            headers: {
              Accept: 'application/ld+json',
              Authorization: `Bearer ${accessToken}`,
            },
          });
          if (descResponse.ok) {
            const desc = await descResponse.json() as any;
            // 查找 notify:subscription 或类似属性
            const subscription = desc['notify:subscription'] || desc['subscription'];
            if (subscription) {
              return typeof subscription === 'string' ? subscription : subscription['@id'];
            }
          }
        }
      }
    } catch {
      // 忽略错误
    }

    return null;
  }

  /**
   * 解析 Link header
   */
  private parseLinkHeader(linkHeader: string, rel: string): string | null {
    const links = linkHeader.split(',');
    for (const link of links) {
      const match = link.match(/<([^>]+)>.*rel="?([^";]+)"?/);
      if (match && match[2] === rel) {
        return match[1];
      }
    }
    return null;
  }
}
