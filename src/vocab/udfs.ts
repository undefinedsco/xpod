/**
 * UDFS Vocabulary - Undefineds.co 词汇表
 *
 * 命名空间: https://undefineds.co/ns#
 * 前缀: udfs
 *
 * 命名规范:
 * - Class: 大写开头 (Credential, Provider, Model)
 * - Property: 小写开头 (apiKey, baseUrl, status)
 */

// ============================================
// Namespace Builder
// ============================================

type NamespaceObject<T extends Record<string, string>> = ((term: string) => string) & {
  prefix: string;
  uri: string;
  /** @deprecated Use `uri` instead */
  NAMESPACE: string;
} & { [K in keyof T]: string };

function createNamespace<T extends Record<string, string>>(
  prefix: string,
  baseUri: string,
  terms: T,
): NamespaceObject<T> {
  const ABSOLUTE_IRI = /^[a-zA-Z][a-zA-Z\d+.-]*:/;

  const builder = ((term: string) =>
    ABSOLUTE_IRI.test(term) ? term : `${baseUri}${term}`) as NamespaceObject<T>;

  builder.prefix = prefix;
  builder.uri = baseUri;
  builder.NAMESPACE = baseUri;

  for (const [key, local] of Object.entries(terms)) {
    Object.defineProperty(builder, key, {
      value: builder(local),
      enumerable: true,
    });
  }

  return builder;
}

// ============================================
// UDFS Vocabulary
// ============================================

export const UDFS = createNamespace('udfs', 'https://undefineds.co/ns#', {
  // ========================================
  // Classes (大写开头)
  // ========================================

  // --- 凭据 ---
  /** 凭据基类 */
  Credential: 'Credential',

  // --- AI 供应商和模型 ---
  /** AI 供应商（Embedding 用） */
  Provider: 'Provider',
  /** AI 模型 */
  Model: 'Model',
  /** Agent 供应商（指定 executorType） */
  AgentProvider: 'AgentProvider',
  /** Agent 配置 */
  AgentConfig: 'AgentConfig',
  /** Agent 运行状态 */
  AgentStatus: 'AgentStatus',
  /** Pod 级别 AI 配置（单例） */
  AIConfig: 'AIConfig',

  // --- 向量存储 ---
  /** 向量知识库 */
  VectorStore: 'VectorStore',
  /** 已索引文件 */
  IndexedFile: 'IndexedFile',

  // --- 任务 ---
  /** 异步任务 */
  Task: 'Task',

  // --- 索引 ---
  /** 文本分块 */
  TextChunk: 'TextChunk',

  // ========================================
  // Properties (小写开头)
  // ========================================

  // --- 通用属性 ---
  /** 状态 */
  status: 'status',
  /** 标签/名称 */
  label: 'label',
  /** 是否启用 */
  enabled: 'enabled',
  /** 创建时间 */
  createdAt: 'createdAt',
  /** 更新时间 */
  updatedAt: 'updatedAt',
  /** 显示名称 */
  displayName: 'displayName',
  /** 描述 */
  description: 'description',

  // --- 凭据属性 ---
  /** API 密钥 */
  apiKey: 'apiKey',
  /** API 基础 URL */
  baseUrl: 'baseUrl',
  /** 代理 URL */
  proxyUrl: 'proxyUrl',
  /** 服务类型 (ai, storage, dns) */
  service: 'service',
  /** 关联的供应商 */
  provider: 'provider',
  /** 最后使用时间 */
  lastUsedAt: 'lastUsedAt',
  /** 失败次数 */
  failCount: 'failCount',
  /** 限流重置时间 */
  rateLimitResetAt: 'rateLimitResetAt',
  /** 项目 ID (Vertex AI) */
  projectId: 'projectId',
  /** 组织 ID (OpenAI) */
  organizationId: 'organizationId',

  // --- AI 模型属性 ---
  /** 模型类型 (embedding, chat, completion) */
  modelType: 'modelType',
  /** 向量维度 */
  dimension: 'dimension',
  /** 当前 embedding 模型 */
  embeddingModel: 'embeddingModel',
  /** 迁移前的模型 */
  previousModel: 'previousModel',
  /** 迁移状态 */
  migrationStatus: 'migrationStatus',
  /** 迁移进度 */
  migrationProgress: 'migrationProgress',
  /** 模型所属供应商 */
  isProvidedBy: 'isProvidedBy',
  /** 供应商拥有的模型 */
  hasModel: 'hasModel',
  /** 默认模型 */
  defaultModel: 'defaultModel',

  // --- Agent 属性 ---
  /** 执行器类型 (claude, openai, gemini, codebuddy) */
  executorType: 'executorType',
  /** System Prompt */
  systemPrompt: 'systemPrompt',
  /** 最大轮数 */
  maxTurns: 'maxTurns',
  /** 超时时间 */
  timeout: 'timeout',
  /** Agent ID */
  agentId: 'agentId',
  /** 启动时间 */
  startedAt: 'startedAt',
  /** 完成时间 */
  completedAt: 'completedAt',
  /** 最后活动时间 */
  lastActivityAt: 'lastActivityAt',
  /** 当前任务 ID */
  currentTaskId: 'currentTaskId',
  /** 错误信息 */
  errorMessage: 'errorMessage',

  // --- 任务属性 ---
  /** 目标 Agent */
  agent: 'agent',
  /** 任务消息 */
  message: 'message',
  /** 执行结果 */
  result: 'result',
  /** 错误 */
  error: 'error',

  // --- 向量存储属性 ---
  /** 名称 */
  name: 'name',
  /** 关联的容器 */
  container: 'container',
  /** 分块策略 */
  chunkingStrategy: 'chunkingStrategy',
  /** 最后活跃时间 */
  lastActiveAt: 'lastActiveAt',

  // --- 索引文件属性 ---
  /** 文件 URL */
  fileUrl: 'fileUrl',
  /** 向量 ID */
  vectorId: 'vectorId',
  /** 使用字节数 */
  usageBytes: 'usageBytes',
  /** 最后错误 */
  lastError: 'lastError',
  /** 索引时间 */
  indexedAt: 'indexedAt',

  // --- 索引层级属性 ---
  /** 索引层级 (L0, L1, L2) */
  indexLevel: 'indexLevel',
  /** 最后索引时间 */
  lastIndexedAt: 'lastIndexedAt',
  /** 缓存的 Markdown */
  cachedMarkdown: 'cachedMarkdown',
  /** 文档的分块 */
  hasChunk: 'hasChunk',
  /** 父分块 */
  parentChunk: 'parentChunk',
  /** 分块层级 */
  level: 'level',
  /** 标题 */
  heading: 'heading',
  /** 起始偏移 */
  startOffset: 'startOffset',
  /** 结束偏移 */
  endOffset: 'endOffset',

  // --- 向量状态属性 (用于 .meta) ---
  /** 向量状态 */
  vectorStatus: 'vectorStatus',
  /** 分块数量 */
  chunkCount: 'chunkCount',
  /** 内容哈希 */
  contentHash: 'contentHash',
  /** 已索引数量 */
  indexedCount: 'indexedCount',
  /** 失败数量 */
  failedCount: 'failedCount',
});

/**
 * UDFS 命名空间配置（用于 drizzle-solid）
 */
export const UDFS_NAMESPACE = {
  prefix: UDFS.prefix,
  uri: UDFS.uri,
};
