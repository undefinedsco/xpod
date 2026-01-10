/**
 * VectorStoreWebhookHandler - 处理 Solid Notification 触发的索引操作
 *
 * 当 VectorStore 关联的 Container 中文件发生变化时，自动触发索引更新：
 * - 文件创建 (as:Create) -> 索引文件
 * - 文件删除 (as:Delete) -> 删除索引
 * - 文件更新 (as:Update) -> 重新索引
 *
 * 使用方式：
 * 1. 用户创建 VectorStore 时，系统自动为 Container 创建 WebSocket 订阅
 * 2. 当文件变化时，Solid Server 发送通知
 * 3. 本 Handler 处理通知并触发相应的索引操作
 */

import { getLoggerFor } from 'global-logger-factory';
import type { VectorStoreService } from '../service/VectorStoreService';
import type { AuthContext } from '../auth/AuthContext';

/**
 * Solid Notification 消息格式 (Activity Streams 2.0)
 */
export interface SolidNotification {
  '@context': string | string[];
  type: 'Create' | 'Update' | 'Delete' | 'Add' | 'Remove';
  actor?: { type: string; id: string };
  object: {
    type?: string | string[];
    id: string; // 资源 URL
  };
  target?: {
    type: string;
    id: string; // Container URL
  };
  published: string;
}

export interface VectorStoreWebhookHandlerOptions {
  vectorStoreService: VectorStoreService;
}

/**
 * VectorStoreWebhookHandler - 处理文件变更通知
 */
export class VectorStoreWebhookHandler {
  private readonly logger = getLoggerFor(this);
  private readonly vectorStoreService: VectorStoreService;

  public constructor(options: VectorStoreWebhookHandlerOptions) {
    this.vectorStoreService = options.vectorStoreService;
  }

  /**
   * 处理 Solid Notification
   *
   * @param notification Solid Notification 消息
   * @param auth 认证上下文
   * @param accessToken 访问令牌
   */
  public async handleNotification(
    notification: SolidNotification,
    auth: AuthContext,
    accessToken: string,
  ): Promise<void> {
    const fileUrl = notification.object.id;
    const containerUrl = notification.target?.id || this.extractContainerUrl(fileUrl);

    this.logger.info(`Received ${notification.type} notification for ${fileUrl} in ${containerUrl}`);

    // 跳过容器本身的变更
    if (fileUrl.endsWith('/')) {
      this.logger.debug(`Skipping container ${fileUrl}`);
      return;
    }

    // 查找所有匹配的 VectorStore（包括父级容器）
    // 例如：A/B/c.txt 应该被索引到 A/ 和 A/B/ 两个 VectorStore
    const vectorStores = await this.vectorStoreService.findVectorStoresByFileUrl(fileUrl, auth);
    
    if (vectorStores.length === 0) {
      this.logger.debug(`No VectorStore configured for file ${fileUrl}, skipping`);
      return;
    }

    this.logger.info(`Found ${vectorStores.length} VectorStore(s) for file ${fileUrl}`);

    // 根据通知类型，对每个匹配的 VectorStore 执行相应操作
    for (const vectorStore of vectorStores) {
      switch (notification.type) {
        case 'Create':
        case 'Add':
        case 'Update':
          await this.handleFileCreatedOrUpdated(vectorStore.id, fileUrl, auth, accessToken);
          break;

        case 'Delete':
        case 'Remove':
          await this.handleFileDeleted(vectorStore.id, fileUrl, auth, accessToken);
          break;

        default:
          this.logger.debug(`Ignoring notification type: ${notification.type}`);
      }
    }
  }

  /**
   * 处理文件创建或更新
   * 注意：文件只索引一份，VectorStore 只是用来定位分块策略
   */
  private async handleFileCreatedOrUpdated(
    _vectorStoreId: string,
    fileUrl: string,
    auth: AuthContext,
    accessToken: string,
  ): Promise<void> {
    try {
      this.logger.info(`Indexing file ${fileUrl}`);
      const result = await this.vectorStoreService.indexFile(fileUrl, auth, accessToken);
      this.logger.info(`Indexed file ${fileUrl}: status=${result.status}, vectorId=${result.vectorId}`);
    } catch (error) {
      this.logger.error(`Failed to index file ${fileUrl}: ${error}`);
      // 不抛出错误，避免影响其他通知处理
    }
  }

  /**
   * 处理文件删除
   * 注意：文件只索引一份，删除时直接按 fileUrl 删除
   */
  private async handleFileDeleted(
    _vectorStoreId: string,
    fileUrl: string,
    auth: AuthContext,
    accessToken: string,
  ): Promise<void> {
    try {
      this.logger.info(`Removing index for file ${fileUrl}`);
      const result = await this.vectorStoreService.removeFileIndex(fileUrl, auth, accessToken);
      this.logger.info(`Removed index for file ${fileUrl}: deleted=${result.deleted}`);
    } catch (error) {
      this.logger.error(`Failed to remove index for file ${fileUrl}: ${error}`);
    }
  }

  /**
   * 从文件 URL 提取容器 URL
   */
  private extractContainerUrl(fileUrl: string): string {
    const lastSlash = fileUrl.lastIndexOf('/');
    if (lastSlash > 0) {
      return fileUrl.slice(0, lastSlash + 1);
    }
    return fileUrl;
  }
}

/**
 * 创建 WebSocket 订阅配置
 *
 * 用于订阅 Container 的文件变更通知
 */
export function createSubscriptionRequest(containerUrl: string): object {
  return {
    '@context': ['https://www.w3.org/ns/solid/notification/v1'],
    type: 'http://www.w3.org/ns/solid/notifications#WebSocketChannel2023',
    topic: containerUrl,
  };
}
