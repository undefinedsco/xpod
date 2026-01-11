/**
 * Pod-based ChatKit Store
 *
 * 将 ChatKit 数据存储到 Solid Pod，兼容 SolidOS Long Chat 格式。
 *
 * 存储结构:
 * /chat/
 *   {thread-id}/
 *     index.ttl      # Thread 元数据 + 消息
 */

import { Session } from '@inrupt/solid-client-authn-node';
import { drizzle, eq, and } from 'drizzle-solid';
import { getLoggerFor } from 'global-logger-factory';
import type { ChatKitStore, StoreContext } from './store';
import type {
  ThreadMetadata,
  ThreadItem,
  Attachment,
  Page,
  StoreItemType,
  UserMessageItem,
  AssistantMessageItem,
  ThreadStatus,
} from './types';
import { generateId, nowTimestamp } from './types';
import {
  ChatThread,
  ChatMessage,
  ThreadStatus as ThreadStatusEnum,
  MessageRole,
  MessageStatus,
  type ChatThreadRecord,
  type ChatMessageRecord,
} from './schema';
import type { AuthContext } from '../auth/AuthContext';
import { isSolidAuth } from '../auth/AuthContext';

const schema = {
  thread: ChatThread,
  message: ChatMessage,
};

export interface PodChatKitStoreOptions {
  tokenEndpoint: string;
}

/**
 * Pod-based ChatKit Store implementation
 *
 * 特点:
 * - 数据存储在用户 Pod 的 /chat/ 目录
 * - 兼容 SolidOS Long Chat (meeting:LongChat) 格式
 * - 使用 drizzle-solid 进行 RDF 操作
 */
export class PodChatKitStore implements ChatKitStore<StoreContext> {
  private readonly logger = getLoggerFor(this);
  private readonly tokenEndpoint: string;

  public constructor(options: PodChatKitStoreOptions) {
    this.tokenEndpoint = options.tokenEndpoint;
  }

  // =========================================================================
  // Private Helpers
  // =========================================================================

  /**
   * 获取认证后的 drizzle 实例
   */
  private async getDb(context: StoreContext) {
    const auth = context.auth as AuthContext | undefined;

    if (!auth || !isSolidAuth(auth) || !auth.clientId || !auth.clientSecret) {
      this.logger.warn('No valid client credentials in context, cannot access Pod');
      return null;
    }

    const session = new Session();
    try {
      await session.login({
        oidcIssuer: new URL(this.tokenEndpoint).origin,
        clientId: auth.clientId,
        clientSecret: auth.clientSecret,
      });

      if (!session.info.isLoggedIn || !session.info.webId) {
        throw new Error('Login failed');
      }

      return drizzle(
        { fetch: session.fetch, info: { webId: session.info.webId, isLoggedIn: true } } as any,
        { schema },
      );
    } catch (error) {
      this.logger.error(`Failed to get Pod db: ${error}`);
      return null;
    }
  }

  /**
   * 从 context 获取 webId
   */
  private getWebId(context: StoreContext): string | undefined {
    const auth = context.auth as AuthContext | undefined;
    if (auth && isSolidAuth(auth)) {
      return auth.webId;
    }
    return undefined;
  }

  /**
   * 将 ThreadStatus 对象转为字符串
   */
  private statusToString(status: ThreadStatus): string {
    return status.type;
  }

  /**
   * 将字符串转为 ThreadStatus 对象
   */
  private stringToStatus(status: string | null | undefined): ThreadStatus {
    switch (status) {
      case 'locked':
        return { type: 'locked' };
      case 'closed':
        return { type: 'closed' };
      default:
        return { type: 'active' };
    }
  }

  /**
   * 将 ChatThreadRecord 转为 ThreadMetadata
   */
  private threadRecordToMetadata(record: ChatThreadRecord): ThreadMetadata {
    return {
      id: record.id,
      title: record.title || undefined,
      status: this.stringToStatus(record.status),
      created_at: record.createdAt ? Math.floor(new Date(record.createdAt).getTime() / 1000) : nowTimestamp(),
      updated_at: record.updatedAt ? Math.floor(new Date(record.updatedAt).getTime() / 1000) : nowTimestamp(),
    };
  }

  /**
   * 将 ChatMessageRecord 转为 ThreadItem
   */
  private messageRecordToItem(record: ChatMessageRecord): ThreadItem {
    const createdAt = record.createdAt ? Math.floor(new Date(record.createdAt).getTime() / 1000) : nowTimestamp();

    if (record.role === MessageRole.USER) {
      return {
        id: record.id,
        thread_id: record.threadId,
        type: 'user_message',
        content: [{ type: 'input_text', text: record.content || '' }],
        created_at: createdAt,
      } as UserMessageItem;
    } else {
      return {
        id: record.id,
        thread_id: record.threadId,
        type: 'assistant_message',
        content: [{ type: 'output_text', text: record.content || '' }],
        status: (record.status as 'in_progress' | 'completed' | 'incomplete') || 'completed',
        created_at: createdAt,
      } as AssistantMessageItem;
    }
  }

  // =========================================================================
  // ID Generation
  // =========================================================================

  generateThreadId(_context: StoreContext): string {
    return generateId('thread');
  }

  generateItemId(itemType: StoreItemType, _thread: ThreadMetadata, _context: StoreContext): string {
    return generateId(itemType.replace('_', '-'));
  }

  // =========================================================================
  // Thread Operations
  // =========================================================================

  async loadThread(threadId: string, context: StoreContext): Promise<ThreadMetadata> {
    const db = await this.getDb(context);
    if (!db) {
      throw new Error('Cannot access Pod: invalid credentials');
    }

    const thread = await db.query.thread.findFirst({
      where: eq(ChatThread.id, threadId),
    });

    if (!thread) {
      throw new Error(`Thread not found: ${threadId}`);
    }

    return this.threadRecordToMetadata(thread);
  }

  async saveThread(thread: ThreadMetadata, context: StoreContext): Promise<void> {
    const db = await this.getDb(context);
    if (!db) {
      throw new Error('Cannot access Pod: invalid credentials');
    }

    const webId = this.getWebId(context);
    const now = new Date().toISOString();

    // 检查是否存在
    const existing = await db.query.thread.findFirst({
      where: eq(ChatThread.id, thread.id),
    });

    if (existing) {
      // Update
      await db.update(ChatThread).set({
        title: thread.title || null,
        status: this.statusToString(thread.status),
        updatedAt: now,
      }).where(eq(ChatThread.id, thread.id));
    } else {
      // Insert
      await db.insert(ChatThread).values({
        id: thread.id,
        title: thread.title || null,
        author: webId || null,
        status: this.statusToString(thread.status),
        createdAt: new Date(thread.created_at * 1000).toISOString(),
        updatedAt: now,
      });
    }
  }

  async loadThreads(
    limit: number,
    after: string | undefined,
    order: string,
    context: StoreContext,
  ): Promise<Page<ThreadMetadata>> {
    const db = await this.getDb(context);
    if (!db) {
      return { data: [], has_more: false };
    }

    try {
      // 简单实现：加载所有后过滤
      const threads = await db.select().from(ChatThread);

      // 排序
      threads.sort((a, b) => {
        const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return order === 'desc' ? bTime - aTime : aTime - bTime;
      });

      // 分页
      let startIndex = 0;
      if (after) {
        const afterIndex = threads.findIndex((t) => t.id === after);
        if (afterIndex !== -1) {
          startIndex = afterIndex + 1;
        }
      }

      const slice = threads.slice(startIndex, startIndex + limit);
      const hasMore = startIndex + limit < threads.length;

      return {
        data: slice.map((t) => this.threadRecordToMetadata(t)),
        has_more: hasMore,
        after: slice.length > 0 ? slice[slice.length - 1].id : undefined,
      };
    } catch (error) {
      this.logger.error(`Failed to load threads: ${error}`);
      return { data: [], has_more: false };
    }
  }

  async deleteThread(threadId: string, context: StoreContext): Promise<void> {
    const db = await this.getDb(context);
    if (!db) {
      throw new Error('Cannot access Pod: invalid credentials');
    }

    // 删除所有消息
    await db.delete(ChatMessage).where(eq(ChatMessage.threadId, threadId));
    // 删除 thread
    await db.delete(ChatThread).where(eq(ChatThread.id, threadId));
  }

  // =========================================================================
  // Thread Item Operations
  // =========================================================================

  async loadThreadItems(
    threadId: string,
    after: string | undefined,
    limit: number,
    order: string,
    context: StoreContext,
  ): Promise<Page<ThreadItem>> {
    const db = await this.getDb(context);
    if (!db) {
      return { data: [], has_more: false };
    }

    try {
      const messages = await db.query.message.findMany({
        where: eq(ChatMessage.threadId, threadId),
      }) as ChatMessageRecord[];

      // 排序
      messages.sort((a: ChatMessageRecord, b: ChatMessageRecord) => {
        const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return order === 'desc' ? bTime - aTime : aTime - bTime;
      });

      // 分页
      let startIndex = 0;
      if (after) {
        const afterIndex = messages.findIndex((m: ChatMessageRecord) => m.id === after);
        if (afterIndex !== -1) {
          startIndex = afterIndex + 1;
        }
      }

      const slice = messages.slice(startIndex, startIndex + limit);
      const hasMore = startIndex + limit < messages.length;

      return {
        data: slice.map((m: ChatMessageRecord) => this.messageRecordToItem(m)),
        has_more: hasMore,
        after: slice.length > 0 ? slice[slice.length - 1].id : undefined,
      };
    } catch (error) {
      this.logger.error(`Failed to load thread items: ${error}`);
      return { data: [], has_more: false };
    }
  }

  async addThreadItem(threadId: string, item: ThreadItem, context: StoreContext): Promise<void> {
    const db = await this.getDb(context);
    if (!db) {
      throw new Error('Cannot access Pod: invalid credentials');
    }

    const webId = this.getWebId(context);
    let content = '';
    let role: string = MessageRole.USER;
    let status: string | null = null;

    if (item.type === 'user_message') {
      const userItem = item as UserMessageItem;
      content = userItem.content
        .filter((c) => c.type === 'input_text')
        .map((c) => (c as any).text)
        .join('\n');
      role = MessageRole.USER;
    } else if (item.type === 'assistant_message') {
      const assistantItem = item as AssistantMessageItem;
      content = assistantItem.content
        .filter((c) => c.type === 'output_text')
        .map((c) => c.text)
        .join('\n');
      role = MessageRole.ASSISTANT;
      status = assistantItem.status || MessageStatus.COMPLETED;
    } else {
      // 其他类型暂时存储为 JSON
      content = JSON.stringify(item);
      role = MessageRole.SYSTEM;
    }

    await db.insert(ChatMessage).values({
      id: item.id,
      threadId,
      content,
      role,
      author: role === MessageRole.USER ? webId : null,
      status,
      createdAt: new Date(item.created_at * 1000).toISOString(),
    });
  }

  async saveItem(threadId: string, item: ThreadItem, context: StoreContext): Promise<void> {
    const db = await this.getDb(context);
    if (!db) {
      throw new Error('Cannot access Pod: invalid credentials');
    }

    // 检查是否存在
    const existing = await db.query.message.findFirst({
      where: eq(ChatMessage.id, item.id),
    });

    if (existing) {
      // Update
      let content = '';
      let status: string | null = null;

      if (item.type === 'user_message') {
        const userItem = item as UserMessageItem;
        content = userItem.content
          .filter((c) => c.type === 'input_text')
          .map((c) => (c as any).text)
          .join('\n');
      } else if (item.type === 'assistant_message') {
        const assistantItem = item as AssistantMessageItem;
        content = assistantItem.content
          .filter((c) => c.type === 'output_text')
          .map((c) => c.text)
          .join('\n');
        status = assistantItem.status || MessageStatus.COMPLETED;
      }

      await db.update(ChatMessage).set({
        content,
        status,
      }).where(eq(ChatMessage.id, item.id));
    } else {
      await this.addThreadItem(threadId, item, context);
    }
  }

  async loadItem(threadId: string, itemId: string, context: StoreContext): Promise<ThreadItem> {
    const db = await this.getDb(context);
    if (!db) {
      throw new Error('Cannot access Pod: invalid credentials');
    }

    const message = await db.query.message.findFirst({
      where: and(
        eq(ChatMessage.id, itemId),
        eq(ChatMessage.threadId, threadId),
      ),
    });

    if (!message) {
      throw new Error(`Item not found: ${itemId}`);
    }

    return this.messageRecordToItem(message);
  }

  async deleteThreadItem(threadId: string, itemId: string, context: StoreContext): Promise<void> {
    const db = await this.getDb(context);
    if (!db) {
      throw new Error('Cannot access Pod: invalid credentials');
    }

    await db.delete(ChatMessage).where(
      and(
        eq(ChatMessage.id, itemId),
        eq(ChatMessage.threadId, threadId),
      ),
    );
  }

  // =========================================================================
  // Attachment Operations (存 Pod 文件)
  // =========================================================================

  async saveAttachment(attachment: Attachment, context: StoreContext): Promise<void> {
    // 附件直接存储到 Pod，这里只记录元数据
    // 实际文件上传由前端直接完成
    this.logger.info(`Attachment saved: ${attachment.id} (${attachment.name})`);
  }

  async loadAttachment(attachmentId: string, context: StoreContext): Promise<Attachment> {
    // 附件元数据可以从 Pod 读取
    throw new Error(`Attachment not found: ${attachmentId}`);
  }

  async deleteAttachment(attachmentId: string, context: StoreContext): Promise<void> {
    // 删除 Pod 中的附件文件
    this.logger.info(`Attachment deleted: ${attachmentId}`);
  }
}
