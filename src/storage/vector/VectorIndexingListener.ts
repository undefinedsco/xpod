/**
 * VectorIndexingListener - 向量索引监听器
 *
 * 监听资源变更事件，自动触发向量索引更新。
 *
 * 工作流程：
 * 1. 收到资源变更事件
 * 2. 检查资源是否在某个 VectorStore 的 scope 内
 * 3. 如果是，读取资源内容，生成 embedding，存入向量库
 */

import { getLoggerFor } from 'global-logger-factory';
import type { ResourceChangeEvent, ResourceChangeListener } from '../ObservableResourceStore';
import type { VectorStore } from '../vector/VectorStore';
import type { EmbeddingService } from '../../ai/service/EmbeddingService';
import type { SparqlEngine } from '../sparql/SubgraphQueryEngine';
import type { AiCredential } from '../../ai/service/types';
import type { ResourceStore, RepresentationPreferences } from '@solid/community-server';

/**
 * VectorStore 定义（从 RDF 读取）
 */
export interface VectorStoreDefinition {
  /** VectorStore URI */
  uri: string;
  /** 索引范围（Container URI） */
  scope: string;
  /** embedding 模型 */
  model: string;
  /** 状态 */
  status: 'active' | 'paused';
  /** 分块大小 */
  chunkSize?: number;
  /** 分块重叠 */
  chunkOverlap?: number;
}

export interface VectorIndexingListenerOptions {
  /** SPARQL 引擎（用于查询 VectorStore 定义和 AI 凭据） */
  sparqlEngine: SparqlEngine;
  /** 向量存储 */
  vectorStore: VectorStore;
  /** Embedding 服务 */
  embeddingService: EmbeddingService;
  /** 资源存储（用于读取资源内容） */
  resourceStore: ResourceStore;
  /** 默认 embedding 模型 */
  defaultModel?: string;
  /** 支持的文件扩展名 */
  supportedExtensions?: string[];
}

/**
 * VectorIndexingListener - 自动向量索引
 */
export class VectorIndexingListener implements ResourceChangeListener {
  protected readonly logger = getLoggerFor(this);

  private readonly sparqlEngine: SparqlEngine;
  private readonly vectorStore: VectorStore;
  private readonly embeddingService: EmbeddingService;
  private readonly resourceStore: ResourceStore;
  private readonly defaultModel: string;
  private readonly supportedExtensions: Set<string>;

  // 缓存 VectorStore 定义，避免频繁查询
  private vectorStoreCache = new Map<string, VectorStoreDefinition[]>();
  private cacheExpiry = 0;
  private readonly cacheTtlMs = 60000; // 1 分钟缓存

  public constructor(options: VectorIndexingListenerOptions) {
    this.sparqlEngine = options.sparqlEngine;
    this.vectorStore = options.vectorStore;
    this.embeddingService = options.embeddingService;
    this.resourceStore = options.resourceStore;
    this.defaultModel = options.defaultModel ?? 'text-embedding-004';
    this.supportedExtensions = new Set(
      options.supportedExtensions ?? ['.txt', '.md', '.html', '.json', '.ttl', '.jsonld'],
    );
  }

  /**
   * 处理资源变更事件
   */
  public async onResourceChanged(event: ResourceChangeEvent): Promise<void> {
    const { path, action, isContainer } = event;

    // 跳过容器变更
    if (isContainer) {
      this.logger.debug(`Skipping container: ${path}`);
      return;
    }

    // 检查文件扩展名
    if (!this.isSupportedFile(path)) {
      this.logger.debug(`Skipping unsupported file type: ${path}`);
      return;
    }

    // 获取 Pod base URL
    const podBaseUrl = this.getPodBaseUrl(path);
    if (!podBaseUrl) {
      this.logger.debug(`Cannot determine pod base URL for: ${path}`);
      return;
    }

    // 如果是 VectorStore 配置文件或 Credential 配置文件更新，清除缓存
    if (path.includes('vector-stores') || path.includes('credentials')) {
      this.logger.debug(`Configuration file updated, clearing cache for ${podBaseUrl}`);
      this.vectorStoreCache.delete(podBaseUrl);
      // 配置文件本身不需要索引，直接返回
      return;
    }

    try {
      // 查找覆盖此路径的 VectorStore
      const vectorStores = await this.findVectorStoresForPath(path, podBaseUrl);
      if (vectorStores.length === 0) {
        this.logger.debug(`No VectorStore configured for: ${path}`);
        return;
      }

      this.logger.info(`Processing ${action} for ${path}, matched ${vectorStores.length} VectorStore(s)`);

      // 根据 action 执行索引操作
      if (action === 'delete') {
        await this.handleDelete(path, vectorStores);
      } else {
        await this.handleCreateOrUpdate(path, podBaseUrl, vectorStores);
      }
    } catch (error) {
      this.logger.error(`Failed to process ${action} for ${path}: ${error}`);
    }
  }

  /**
   * 处理删除操作
   */
  private async handleDelete(path: string, vectorStores: VectorStoreDefinition[]): Promise<void> {
    const vectorId = this.pathToVectorId(path);

    for (const vs of vectorStores) {
      try {
        await this.vectorStore.deleteVector(vs.model, vectorId);
        this.logger.info(`Deleted vector for ${path} from model ${vs.model}`);
      } catch (error) {
        this.logger.error(`Failed to delete vector for ${path}: ${error}`);
      }
    }
  }

  /**
   * 处理创建或更新操作
   */
  private async handleCreateOrUpdate(
    path: string,
    podBaseUrl: string,
    vectorStores: VectorStoreDefinition[],
  ): Promise<void> {
    // 读取资源内容
    const content = await this.getResourceContent(path);
    if (!content || content.trim().length === 0) {
      this.logger.debug(`Empty content for ${path}, skipping`);
      return;
    }

    // 获取 AI 凭据
    const credential = await this.getAiCredential(podBaseUrl);
    if (!credential) {
      this.logger.warn(`No AI credential found for ${podBaseUrl}, skipping indexing`);
      return;
    }

    // 为每个 VectorStore 生成 embedding 并存储
    // 注意：如果多个 VectorStore 使用相同的 model，只需要生成一次 embedding
    const modelEmbeddings = new Map<string, number[]>();

    for (const vs of vectorStores) {
      if (vs.status !== 'active') {
        this.logger.debug(`VectorStore ${vs.uri} is ${vs.status}, skipping`);
        continue;
      }

      const model = vs.model || this.defaultModel;

      try {
        // 检查是否已经生成过这个 model 的 embedding
        let embedding = modelEmbeddings.get(model);
        if (!embedding) {
          embedding = await this.embeddingService.embed(content, credential, model);
          modelEmbeddings.set(model, embedding);
        }

        // 确保向量表存在
        await this.vectorStore.ensureVectorTable(model);

        // 存储向量
        const vectorId = this.pathToVectorId(path);
        await this.vectorStore.upsertVector(model, vectorId, embedding);

        this.logger.info(`Indexed ${path} to model ${model}, vectorId=${vectorId}`);
      } catch (error) {
        this.logger.error(`Failed to index ${path} to model ${model}: ${error}`);
      }
    }
  }

  /**
   * 查找覆盖指定路径的 VectorStore
   */
  private async findVectorStoresForPath(
    path: string,
    podBaseUrl: string,
  ): Promise<VectorStoreDefinition[]> {
    const allStores = await this.getVectorStoreDefinitions(podBaseUrl);

    return allStores.filter((vs) => {
      // 检查 path 是否在 scope 内
      const scope = vs.scope.endsWith('/') ? vs.scope : `${vs.scope}/`;
      return path.startsWith(scope);
    });
  }

  /**
   * 获取 Pod 的所有 VectorStore 定义
   */
  private async getVectorStoreDefinitions(podBaseUrl: string): Promise<VectorStoreDefinition[]> {
    // 检查缓存
    if (Date.now() < this.cacheExpiry && this.vectorStoreCache.has(podBaseUrl)) {
      return this.vectorStoreCache.get(podBaseUrl)!;
    }

    try {
      // 使用 undefineds.co/ns# 命名空间，与 drizzle-solid schema 一致
      const query = `
        PREFIX udfs: <https://undefineds.co/ns#>
        SELECT ?vs ?scope ?model ?status ?chunkSize ?chunkOverlap WHERE {
          ?vs a udfs:VectorStore ;
              udfs:container ?scope .
          OPTIONAL { ?vs udfs:chunkingStrategy ?model }
          OPTIONAL { ?vs udfs:status ?status }
          OPTIONAL { ?vs udfs:chunkSize ?chunkSize }
          OPTIONAL { ?vs udfs:chunkOverlap ?chunkOverlap }
        }
      `;

      const bindingsStream = await this.sparqlEngine.queryBindings(query, podBaseUrl);
      const definitions: VectorStoreDefinition[] = [];

      for await (const binding of bindingsStream) {
        const vs = binding.get('vs');
        const scope = binding.get('scope');
        const model = binding.get('model');
        const status = binding.get('status');
        const chunkSize = binding.get('chunkSize');
        const chunkOverlap = binding.get('chunkOverlap');

        if (vs && scope) {
          definitions.push({
            uri: vs.value,
            scope: this.resolveUri(scope.value, podBaseUrl),
            model: model?.value || this.defaultModel,
            status: (status?.value as 'active' | 'paused') || 'active',
            chunkSize: chunkSize ? parseInt(chunkSize.value, 10) : undefined,
            chunkOverlap: chunkOverlap ? parseInt(chunkOverlap.value, 10) : undefined,
          });
        }
      }

      // 更新缓存
      this.vectorStoreCache.set(podBaseUrl, definitions);
      this.cacheExpiry = Date.now() + this.cacheTtlMs;

      this.logger.debug(`Found ${definitions.length} VectorStore(s) for ${podBaseUrl}`);
      return definitions;
    } catch (error) {
      this.logger.error(`Failed to query VectorStore definitions: ${error}`);
      return [];
    }
  }

  /**
   * 获取 AI 凭据
   */
  private async getAiCredential(podBaseUrl: string): Promise<AiCredential | null> {
    try {
      // 使用 undefineds.co/ns# 命名空间，与 drizzle-solid schema 一致
      // Credential -> Provider 关联，从 Provider 获取 baseUrl 和 proxyUrl
      const query = `
        PREFIX udfs: <https://undefineds.co/ns#>
        SELECT ?apiKey ?baseUrl ?providerUri ?proxyUrl WHERE {
          ?cred a udfs:Credential ;
                udfs:service "ai" ;
                udfs:status "active" ;
                udfs:apiKey ?apiKey .
          OPTIONAL { ?cred udfs:provider ?providerUri }
          OPTIONAL { 
            ?cred udfs:provider ?providerUri .
            ?providerUri udfs:baseUrl ?baseUrl .
          }
          OPTIONAL { 
            ?cred udfs:provider ?providerUri .
            ?providerUri udfs:proxyUrl ?proxyUrl .
          }
        } LIMIT 1
      `;

      const bindingsStream = await this.sparqlEngine.queryBindings(query, podBaseUrl);

      for await (const binding of bindingsStream) {
        const apiKey = binding.get('apiKey');
        const baseUrl = binding.get('baseUrl');
        const providerUri = binding.get('providerUri');
        const proxyUrl = binding.get('proxyUrl');

        if (apiKey) {
          // 从 provider URI 提取 provider 名称（如 #google -> google）
          let providerName = 'google';
          if (providerUri?.value) {
            const match = providerUri.value.match(/#([^#]+)$/);
            if (match) providerName = match[1];
          }
          
          return {
            apiKey: apiKey.value,
            baseUrl: baseUrl?.value,
            provider: providerName,
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
   * 读取资源内容
   */
  private async getResourceContent(path: string): Promise<string | null> {
    try {
      const preferences: RepresentationPreferences = {
        type: { 'text/plain': 1, 'text/markdown': 0.9, 'text/turtle': 0.8, '*/*': 0.1 },
      };

      const representation = await this.resourceStore.getRepresentation({ path }, preferences);
      const chunks: Buffer[] = [];

      for await (const chunk of representation.data) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }

      return Buffer.concat(chunks).toString('utf-8');
    } catch (error) {
      this.logger.error(`Failed to read resource ${path}: ${error}`);
      return null;
    }
  }

  /**
   * 检查是否为支持的文件类型
   */
  private isSupportedFile(path: string): boolean {
    const ext = this.getExtension(path);
    return this.supportedExtensions.has(ext);
  }

  /**
   * 获取文件扩展名
   */
  private getExtension(path: string): string {
    const lastDot = path.lastIndexOf('.');
    if (lastDot === -1) return '';
    return path.slice(lastDot).toLowerCase();
  }

  /**
   * 从路径提取 Pod base URL
   */
  private getPodBaseUrl(path: string): string | null {
    // 假设路径格式为 /username/... 或 https://pod.example.com/username/...
    try {
      const url = new URL(path, 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts.length > 0) {
        return `${url.origin}/${parts[0]}/`;
      }
    } catch {
      // 相对路径
      const parts = path.split('/').filter(Boolean);
      if (parts.length > 0) {
        return `/${parts[0]}/`;
      }
    }
    return null;
  }

  /**
   * 解析相对 URI
   */
  private resolveUri(uri: string, baseUrl: string): string {
    if (uri.startsWith('http://') || uri.startsWith('https://')) {
      return uri;
    }
    if (uri.startsWith('/')) {
      try {
        const base = new URL(baseUrl);
        return `${base.origin}${uri}`;
      } catch {
        return uri;
      }
    }
    return `${baseUrl}${uri}`;
  }

  /**
   * 将路径转换为向量 ID（使用 hash）
   */
  private pathToVectorId(path: string): number {
    let hash = 2166136261; // FNV offset basis
    for (let i = 0; i < path.length; i++) {
      hash ^= path.charCodeAt(i);
      hash = Math.imul(hash, 16777619); // FNV prime
    }
    return Math.abs(hash);
  }

  /**
   * 清除缓存
   */
  public clearCache(): void {
    this.vectorStoreCache.clear();
    this.cacheExpiry = 0;
  }
}
