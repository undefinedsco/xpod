/**
 * IndexTaskHandler - 索引任务处理器
 *
 * 处理 IndexTask，为每个 chunk 生成 embedding 并存储到向量库。
 * 实现 TaskHandler 接口，由 TaskExecutor 调用。
 */

import { getLoggerFor } from 'global-logger-factory';
import type { Task, TaskHandler, TaskExecutionContext, TaskResult, TaskClassType } from '../../task/types';
import type { EmbeddingService } from '../../../ai/service/EmbeddingService';
import type { AiCredential } from '../../../ai/service/types';
import type { IndexTaskPayload } from './IndexingService';
import { TaskClass } from '../../task/schema';

export interface IndexTaskHandlerOptions {
  /** Embedding 服务 */
  embeddingService: EmbeddingService;
  /** CSS 基础 URL */
  cssBaseUrl: string;
  /** 获取 AI credential 的函数 */
  getCredential: (webId: string) => Promise<AiCredential | undefined>;
  /** 获取 embedding model 的函数 */
  getEmbeddingModel: (webId: string) => Promise<string | undefined>;
}

/**
 * 执行结果数据
 */
interface IndexResultData {
  documentUrl: string;
  totalChunks: number;
  successCount: number;
  failCount: number;
  results: Array<{
    chunkId: string;
    success: boolean;
    vectorId?: number;
    error?: string;
  }>;
}

/**
 * IndexTaskHandler - 处理 IndexTask
 */
export class IndexTaskHandler implements TaskHandler<IndexTaskPayload, IndexResultData> {
  private readonly logger = getLoggerFor(this);
  private readonly embeddingService: EmbeddingService;
  private readonly cssBaseUrl: string;
  private readonly getCredentialFn: (webId: string) => Promise<AiCredential | undefined>;
  private readonly getEmbeddingModelFn: (webId: string) => Promise<string | undefined>;

  public readonly taskClass: TaskClassType = TaskClass.INDEX;

  public constructor(options: IndexTaskHandlerOptions) {
    this.embeddingService = options.embeddingService;
    this.cssBaseUrl = options.cssBaseUrl.replace(/\/$/, '');
    this.getCredentialFn = options.getCredential;
    this.getEmbeddingModelFn = options.getEmbeddingModel;
  }

  /**
   * 执行索引任务
   */
  public async execute(
    task: Task<IndexTaskPayload>,
    context: TaskExecutionContext,
  ): Promise<TaskResult<IndexResultData>> {
    const payload = task.payload;

    if (!payload) {
      return {
        success: false,
        error: 'No payload in task',
      };
    }

    const { documentUrl, accessToken, chunks } = payload;

    context.log.info(`Executing index task ${task.id} for ${documentUrl} with ${chunks.length} chunks`);

    try {
      // 从 documentUrl 推断 webId
      const webId = this.extractWebId(documentUrl);
      if (!webId) {
        return {
          success: false,
          error: 'Cannot determine webId from document URL',
        };
      }

      // 获取 AI credential 和 model
      const credential = await this.getCredentialFn(webId);
      if (!credential) {
        return {
          success: false,
          error: 'No AI credential found',
        };
      }

      const model = await this.getEmbeddingModelFn(webId);
      if (!model) {
        return {
          success: false,
          error: 'No embedding model configured',
        };
      }

      // 处理每个 chunk
      const results: IndexResultData['results'] = [];
      const totalChunks = chunks.length;

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];

        try {
          // 生成 embedding
          const embedding = await this.embeddingService.embed(chunk.content, credential, model);

          // 计算 vector ID（基于 documentUrl + chunkId）
          const vectorId = this.hashChunkId(documentUrl, chunk.id);

          // 存储向量
          await this.upsertVector(model, vectorId, embedding, accessToken, {
            subject: documentUrl,
            chunkId: chunk.id,
            heading: chunk.heading,
          });

          results.push({ chunkId: chunk.id, success: true, vectorId });

          // 更新进度
          const progress = Math.round(((i + 1) / totalChunks) * 100);
          await context.updateProgress(progress);
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          context.log.error(`Failed to embed chunk ${chunk.id}: ${errorMsg}`);
          results.push({ chunkId: chunk.id, success: false, error: errorMsg });
        }
      }

      // 统计结果
      const successCount = results.filter(r => r.success).length;
      const failCount = results.filter(r => !r.success).length;

      context.log.info(`Index task ${task.id} completed: ${successCount} success, ${failCount} failed`);

      return {
        success: failCount === 0,
        data: {
          documentUrl,
          totalChunks,
          successCount,
          failCount,
          results,
        },
        error: failCount > 0 ? `${failCount} chunks failed to index` : undefined,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      context.log.error(`Index task ${task.id} failed: ${errorMsg}`);

      return {
        success: false,
        error: errorMsg,
      };
    }
  }

  /**
   * 任务开始前的钩子
   */
  public async onStart(task: Task<IndexTaskPayload>): Promise<void> {
    this.logger.debug(`Index task ${task.id} starting for ${task.payload?.documentUrl}`);
  }

  /**
   * 任务完成后的钩子
   */
  public async onComplete(
    task: Task<IndexTaskPayload>,
    result: TaskResult<IndexResultData>,
  ): Promise<void> {
    this.logger.debug(
      `Index task ${task.id} completed: success=${result.success}, chunks=${result.data?.totalChunks}`,
    );
  }

  /**
   * 任务失败后的钩子
   */
  public async onFailed(task: Task<IndexTaskPayload>, error: string): Promise<void> {
    this.logger.warn(`Index task ${task.id} failed: ${error}`);
  }

  /**
   * 从 URL 提取 WebId
   */
  private extractWebId(url: string): string | null {
    try {
      const parsed = new URL(url);
      // 假设格式为 https://pod.example.com/username/...
      const parts = parsed.pathname.split('/').filter(Boolean);
      if (parts.length > 0) {
        return `${parsed.origin}/${parts[0]}/profile/card#me`;
      }
    } catch {
      // 忽略解析错误
    }
    return null;
  }

  /**
   * Hash documentUrl + chunkId 为向量 ID
   */
  private hashChunkId(documentUrl: string, chunkId: string): number {
    const str = `${documentUrl}|${chunkId}`;
    let hash = 2166136261; // FNV offset basis
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = Math.imul(hash, 16777619); // FNV prime
    }
    return Math.abs(hash);
  }

  /**
   * 存储向量到 CSS
   */
  private async upsertVector(
    model: string,
    id: number,
    vector: number[],
    accessToken: string,
    metadata: { subject: string; chunkId: string; heading: string },
  ): Promise<void> {
    const url = `${this.cssBaseUrl}/-/vector/upsert`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        model,
        vectors: [{
          id,
          vector,
          metadata: {
            subject: metadata.subject,
            chunkId: metadata.chunkId,
            heading: metadata.heading,
          },
        }],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Vector upsert failed: ${response.status} ${errorText}`);
    }
  }
}
