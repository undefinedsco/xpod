/**
 * IndexingService - 文档索引服务
 *
 * 负责将文档解析、分块并创建索引任务。
 * 使用 TaskQueue 管理索引任务，支持异步处理。
 *
 * 工作流程：
 * 1. 接收文档 URL
 * 2. 使用 DocumentParser (JINA) 解析文档为 Markdown
 * 3. 使用 Chunker 按标题层级分块
 * 4. 将分块元数据存储到文件的 .meta 辅助资源
 * 5. 创建 embedding 任务到 TaskQueue
 */

import { getLoggerFor } from 'global-logger-factory';
import type { DocumentParser, ParsedDocument } from '../../document/DocumentParser';
import type { Chunker, TextChunk } from '../../document/Chunker';
import type { TaskQueue, Task, CreateTaskInput } from '../../task/types';
import { TaskClass, TaskSource } from '../../task/schema';

/**
 * 索引请求
 */
export interface IndexRequest {
  /** 文档 URL */
  url: string;
  /** 访问令牌 */
  accessToken: string;
  /** 强制重新索引 */
  force?: boolean;
}

/**
 * 索引结果
 */
export interface IndexResult {
  /** 文档 URL */
  url: string;
  /** 任务 ID */
  taskId: string;
  /** 分块数量 */
  chunkCount: number;
  /** 状态 */
  status: 'queued' | 'completed' | 'failed';
  /** 错误信息 */
  error?: string;
}

/**
 * Chunk 元数据（存储到 .meta）
 */
export interface ChunkMetadata {
  id: string;
  level: number;
  heading: string;
  startOffset: number;
  endOffset: number;
  path: string[];
  parentId?: string;
}

export interface IndexingServiceOptions {
  /** 文档解析器 */
  documentParser: DocumentParser;
  /** 分块器 */
  chunker: Chunker;
  /** 任务队列 */
  taskQueue: TaskQueue;
  /** CSS 基础 URL（用于写入 .meta） */
  cssBaseUrl: string;
}

/**
 * IndexingService - 文档索引服务
 */
export class IndexingService {
  private readonly logger = getLoggerFor(this);
  private readonly documentParser: DocumentParser;
  private readonly chunker: Chunker;
  private readonly taskQueue: TaskQueue;
  private readonly cssBaseUrl: string;

  public constructor(options: IndexingServiceOptions) {
    this.documentParser = options.documentParser;
    this.chunker = options.chunker;
    this.taskQueue = options.taskQueue;
    this.cssBaseUrl = options.cssBaseUrl.replace(/\/$/, '');
  }

  /**
   * 索引文档
   *
   * 1. 解析文档
   * 2. 分块
   * 3. 存储分块元数据到 .meta
   * 4. 创建 embedding 任务
   */
  public async indexDocument(request: IndexRequest): Promise<IndexResult> {
    const { url, accessToken, force } = request;

    this.logger.info(`Starting indexing for ${url}`);

    try {
      // 1. 解析文档
      const parsed = await this.documentParser.parse(url);
      if (!parsed.markdown || parsed.markdown.trim().length === 0) {
        return {
          url,
          taskId: '',
          chunkCount: 0,
          status: 'failed',
          error: 'Document has no content',
        };
      }

      // 2. 分块
      const chunks = this.chunker.chunk(parsed.markdown);

      if (chunks.length === 0) {
        return {
          url,
          taskId: '',
          chunkCount: 0,
          status: 'failed',
          error: 'No chunks generated from document',
        };
      }

      // 3. 存储分块元数据到 .meta
      await this.storeChunkMetadata(url, chunks, accessToken);

      // 4. 创建索引任务
      const task = await this.createIndexTask(url, chunks, accessToken);

      this.logger.info(`Created index task ${task.id} for ${url} with ${chunks.length} chunks`);

      return {
        url,
        taskId: task.id,
        chunkCount: chunks.length,
        status: 'queued',
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to index ${url}: ${errorMsg}`);

      return {
        url,
        taskId: '',
        chunkCount: 0,
        status: 'failed',
        error: errorMsg,
      };
    }
  }

  /**
   * 批量索引文档
   */
  public async indexDocuments(requests: IndexRequest[]): Promise<IndexResult[]> {
    const results: IndexResult[] = [];

    for (const request of requests) {
      const result = await this.indexDocument(request);
      results.push(result);
    }

    return results;
  }

  /**
   * 存储分块元数据到 .meta 辅助资源
   *
   * 将 chunks 作为 RDF inline entities 存储到文件的 .meta
   */
  private async storeChunkMetadata(
    documentUrl: string,
    chunks: TextChunk[],
    accessToken: string,
  ): Promise<void> {
    const metaUrl = this.getMetaUrl(documentUrl);

    // 构建 RDF Turtle 格式的 chunk 元数据
    const turtle = this.buildChunkMetadataTurtle(documentUrl, chunks);

    // PATCH 请求更新 .meta
    const response = await fetch(metaUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'text/turtle',
        Authorization: `Bearer ${accessToken}`,
      },
      body: turtle,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to store chunk metadata: ${response.status} ${errorText}`);
    }

    this.logger.debug(`Stored ${chunks.length} chunk metadata to ${metaUrl}`);
  }

  /**
   * 构建 chunk 元数据的 Turtle 格式
   */
  private buildChunkMetadataTurtle(documentUrl: string, chunks: TextChunk[]): string {
    const lines: string[] = [
      '@prefix udfs: <https://undefineds.co/ns#> .',
      '@prefix schema: <https://schema.org/> .',
      '@prefix dcterms: <http://purl.org/dc/terms/> .',
      '@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .',
      '',
      `<${documentUrl}> udfs:chunks [`,
    ];

    // 递归添加所有 chunks
    const flatChunks = this.flattenChunks(chunks);

    for (let i = 0; i < flatChunks.length; i++) {
      const chunk = flatChunks[i];
      const isLast = i === flatChunks.length - 1;

      lines.push(`    udfs:chunk [
        a udfs:TextChunk ;
        dcterms:identifier "${chunk.id}" ;
        udfs:level ${chunk.level} ;
        udfs:heading "${this.escapeTurtle(chunk.heading)}" ;
        udfs:startOffset ${chunk.startOffset} ;
        udfs:endOffset ${chunk.endOffset} ;
        udfs:path "${chunk.path.join('/')}"${chunk.parentId ? ` ;
        udfs:parentChunk "${chunk.parentId}"` : ''}
    ]${isLast ? '' : ' ,'}`);
    }

    lines.push('] .');

    return lines.join('\n');
  }

  /**
   * 将嵌套的 chunks 展平
   */
  private flattenChunks(chunks: TextChunk[]): TextChunk[] {
    const result: TextChunk[] = [];

    const flatten = (chunk: TextChunk): void => {
      result.push(chunk);
      for (const child of chunk.children) {
        flatten(child);
      }
    };

    for (const chunk of chunks) {
      flatten(chunk);
    }

    return result;
  }

  /**
   * 转义 Turtle 字符串
   */
  private escapeTurtle(str: string): string {
    return str
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t');
  }

  /**
   * 获取文件的 .meta URL
   */
  private getMetaUrl(documentUrl: string): string {
    // 按 Solid 规范，.meta 是辅助资源
    // 例如 https://pod.example/file.md -> https://pod.example/file.md.meta
    return `${documentUrl}.meta`;
  }

  /**
   * 创建索引任务
   */
  private async createIndexTask(
    documentUrl: string,
    chunks: TextChunk[],
    accessToken: string,
  ): Promise<Task> {
    const flatChunks = this.flattenChunks(chunks);

    const taskInput: CreateTaskInput<IndexTaskPayload> = {
      '@type': TaskClass.INDEX,
      target: documentUrl,
      priority: 'normal',
      source: TaskSource.SYSTEM,
      instruction: `Index document with ${flatChunks.length} chunks`,
      payload: {
        documentUrl,
        accessToken,
        chunks: flatChunks.map(c => ({
          id: c.id,
          content: c.content,
          heading: c.heading,
          level: c.level,
          startOffset: c.startOffset,
          endOffset: c.endOffset,
        })),
      },
    };

    return this.taskQueue.createTask(taskInput);
  }

  /**
   * 重新索引文档（删除旧的 chunks，重新解析）
   */
  public async reindexDocument(request: IndexRequest): Promise<IndexResult> {
    // 先删除旧的 chunk metadata
    try {
      await this.deleteChunkMetadata(request.url, request.accessToken);
    } catch (error) {
      this.logger.warn(`Failed to delete old chunk metadata for ${request.url}: ${error}`);
      // 继续执行，即使删除失败
    }

    // 重新索引
    return this.indexDocument({ ...request, force: true });
  }

  /**
   * 删除分块元数据
   */
  private async deleteChunkMetadata(documentUrl: string, accessToken: string): Promise<void> {
    const metaUrl = this.getMetaUrl(documentUrl);

    const response = await fetch(metaUrl, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    // 404 也算成功（可能本来就没有）
    if (!response.ok && response.status !== 404) {
      const errorText = await response.text();
      throw new Error(`Failed to delete chunk metadata: ${response.status} ${errorText}`);
    }
  }
}

/**
 * 索引任务的 payload
 */
export interface IndexTaskPayload {
  documentUrl: string;
  accessToken: string;
  chunks: Array<{
    id: string;
    content: string;
    heading: string;
    level: number;
    startOffset: number;
    endOffset: number;
  }>;
}
