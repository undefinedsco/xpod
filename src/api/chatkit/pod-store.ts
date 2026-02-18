/**
 * Pod-based ChatKit Store
 *
 * 将 ChatKit 数据存储到 Solid Pod。
 *
 * 存储结构:
 * /.data/chat/{chatId}/
 *   index.ttl
 *     #this                           # Chat (meeting:LongChat)
 *     #{threadId}                     # Thread (sioc:Thread)
 *   {yyyy}/{MM}/{dd}/messages.ttl     # Messages (meeting:Message)
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
  Chat,
  Thread,
  Message,
  MessageRole,
  MessageStatus,
  type ChatRecord,
  type ThreadRecord,
  type MessageRecord,
} from './schema';
import type { AuthContext } from '../auth/AuthContext';
import { isSolidAuth } from '../auth/AuthContext';
import { Provider } from '../../ai/schema/provider';
import { Credential } from '../../credential/schema/tables';
import { ServiceType, CredentialStatus } from '../../credential/schema/types';

const schema = {
  chat: Chat,
  thread: Thread,
  message: Message,
  provider: Provider,
  credential: Credential,
};

export interface PodChatKitStoreOptions {
  tokenEndpoint: string;
}

/**
 * Pod-based ChatKit Store implementation
 *
 * 数据模型映射：
 * - ChatKit thread = Thread (sioc:Thread)
 * - ChatKit thread item = Message (meeting:Message)
 * - Chat (meeting:LongChat) 是容器/Agent，通过 metadata.chat_id 暴露
 *
 * 每个 Thread 属于一个 Chat 容器。默认使用 'default' Chat。
 */
export class PodChatKitStore implements ChatKitStore<StoreContext> {
  private readonly logger = getLoggerFor(this);
  private readonly tokenEndpoint: string;

  /** 默认 Chat 容器 ID */
  private static readonly DEFAULT_CHAT_ID = 'default';

  public constructor(options: PodChatKitStoreOptions) {
    this.tokenEndpoint = options.tokenEndpoint;
  }

  // =========================================================================
  // Private Helpers
  // =========================================================================

  /**
   * 获取认证后的 drizzle 实例 (缓存到 context 中)
   */
  private async getDb(context: StoreContext) {
    // Check if we already have a cached db in context
    if ((context as any)._cachedDb) {
      return (context as any)._cachedDb;
    }

    const auth = context.auth as AuthContext | undefined;

    if (!auth || !isSolidAuth(auth)) {
      this.logger.warn('No valid solid auth in context, cannot access Pod');
      return null;
    }

    // Preferred path: directly use caller's Solid access token.
    if (auth.accessToken && auth.webId) {
      try {
        if (auth.tokenType === 'DPoP') {
          this.logger.warn('Using DPoP access token without proof key; Pod access may fail if issuer enforces DPoP proof');
        }

        const authFetch = this.createAccessTokenFetch(auth.accessToken, auth.tokenType);
        const db = drizzle(
          { fetch: authFetch, info: { webId: auth.webId, isLoggedIn: true } } as any,
          { schema },
        );

        this.logger.info(`Initializing tables for Pod (access token): ${auth.webId}`);
        try {
          await db.init([Chat, Thread, Message]);
          this.logger.info('Tables initialized successfully');
        } catch (initError) {
          this.logger.error(`Failed to init tables: ${initError}`);
        }

        (context as any)._cachedDb = db;
        (context as any)._cachedFetch = authFetch;
        (context as any)._cachedWebId = auth.webId;
        return db;
      } catch (error) {
        this.logger.error(`Failed to get Pod db with access token: ${error}`);
        return null;
      }
    }

    if (!auth.clientId || !auth.clientSecret) {
      this.logger.warn('No accessToken and no valid client credentials in context, cannot access Pod');
      return null;
    }

    // Fallback path: login with client credentials to obtain a Pod session.
    const session = new Session();
    try {
      await session.login({
        oidcIssuer: new URL(this.tokenEndpoint).origin,
        clientId: auth.clientId,
        clientSecret: auth.clientSecret,
        tokenType: 'DPoP',
      });

      if (!session.info.isLoggedIn || !session.info.webId) {
        throw new Error('Login failed');
      }

      const authFetch = session.fetch.bind(session) as typeof fetch;
      const db = drizzle(
        { fetch: authFetch, info: { webId: session.info.webId, isLoggedIn: true } } as any,
        { schema },
      );


      // 初始化表（创建容器、资源）
      this.logger.info(`Initializing tables for Pod: ${session.info.webId}`);
      try {
        await db.init([Chat, Thread, Message]);
        this.logger.info('Tables initialized successfully');
      } catch (initError) {
        this.logger.error(`Failed to init tables: ${initError}`);
        // 继续执行，可能容器已存在
      }

      // Cache both db and session.fetch in context for reuse
      (context as any)._cachedDb = db;
      (context as any)._cachedFetch = authFetch;
      (context as any)._cachedWebId = session.info.webId;

      return db;
    } catch (error) {
      this.logger.error(`Failed to get Pod db: ${error}`);
      return null;
    }
  }

  private createAccessTokenFetch(accessToken: string, tokenType?: 'Bearer' | 'DPoP'): typeof fetch {
    const scheme = tokenType ?? 'Bearer';
    return async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ): Promise<Response> => {
      const headers = new Headers(init?.headers);
      if (!headers.has('Authorization')) {
        headers.set('Authorization', `${scheme} ${accessToken}`);
      }
      return fetch(input, {
        ...init,
        headers,
      });
    };
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
   * 从 ThreadMetadata.metadata 中获取 chat_id，如果没有则返回默认值
   */
  private getChatIdFromMetadata(metadata?: Record<string, unknown>): string {
    if (metadata && typeof metadata.chat_id === 'string') {
      return metadata.chat_id;
    }
    return PodChatKitStore.DEFAULT_CHAT_ID;
  }

  /**
   * 确保 Chat 容器存在，如果不存在则创建
   */
  private async ensureChat(chatId: string, context: StoreContext): Promise<void> {
    const db = await this.getDb(context);
    if (!db) {
      throw new Error('Cannot access Pod: invalid credentials');
    }

    const webId = this.getWebId(context);

    // 检查是否存在
    const existing = await db.query.chat.findFirst({
      where: eq(Chat.id, chatId),
    });

    if (!existing) {
      // 创建 Chat 容器
      const now = new Date().toISOString();
      await db.insert(Chat).values({
        id: chatId,
        title: chatId === PodChatKitStore.DEFAULT_CHAT_ID ? 'Default Chat' : chatId,
        author: webId || null,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
      this.logger.info(`Created Chat container: ${chatId}`);
    }
  }

  /**
   * 将 ThreadRecord 转为 ThreadMetadata
   * 包含 metadata.chat_id 暴露 Chat 容器 ID
   */
  private threadRecordToMetadata(record: ThreadRecord): ThreadMetadata {
    const chatId = this.extractChatId(record.chatId);
    let extra: Record<string, unknown> | undefined;
    if (record.metadata) {
      try {
        extra = JSON.parse(record.metadata) as Record<string, unknown>;
      } catch {
        // ignore invalid metadata
      }
    }

    return {
      id: record.id,
      title: record.title || undefined,
      status: this.stringToStatus(record.status),
      created_at: record.createdAt ? Math.floor(new Date(record.createdAt).getTime() / 1000) : nowTimestamp(),
      updated_at: record.updatedAt ? Math.floor(new Date(record.updatedAt).getTime() / 1000) : nowTimestamp(),
      metadata: {
        chat_id: chatId,
        ...(extra ?? {}),
      },
    };
  }

  /**
   * 将 MessageRecord 转为 ThreadItem
   * thread_id 返回 Message 所属的 Thread ID
   */
  private messageRecordToItem(record: MessageRecord, threadId: string): ThreadItem {
    const createdAt = record.createdAt ? Math.floor(new Date(record.createdAt).getTime() / 1000) : nowTimestamp();

    if (record.role === MessageRole.USER) {
      return {
        id: record.id,
        thread_id: threadId,
        type: 'user_message',
        content: [{ type: 'input_text', text: record.content || '' }],
        created_at: createdAt,
      } as UserMessageItem;
    } else {
      return {
        id: record.id,
        thread_id: threadId,
        type: 'assistant_message',
        content: [{ type: 'output_text', text: record.content || '' }],
        status: (record.status as 'in_progress' | 'completed' | 'incomplete') || 'completed',
        created_at: createdAt,
      } as AssistantMessageItem;
    }
  }

  /**
   * 从 Thread 获取 chatId（提取纯 ID）
   */
  private extractChatId(chatIdOrUri: string | null | undefined): string {
    if (!chatIdOrUri) return PodChatKitStore.DEFAULT_CHAT_ID;

    if (chatIdOrUri.includes('#')) {
      // 从 URI 中提取，如 http://.../.data/chat/default/index.ttl#this -> default
      const match = chatIdOrUri.match(/\.data\/chat\/([^/]+)\/index\.ttl#this/);
      if (match) {
        return match[1];
      }
    }
    return chatIdOrUri;
  }

  /**
   * 获取 Thread 的 chatId
   * 先从缓存获取，如果没有再查询数据库
   */
  private async getThreadChatId(threadId: string, context: StoreContext): Promise<string> {
    // 先检查缓存
    const cached = this.getCachedThreadChatId(context, threadId);
    if (cached) {
      return cached;
    }

    const db = await this.getDb(context);
    if (!db) {
      throw new Error('Cannot access Pod: invalid credentials');
    }

    const thread = await db.query.thread.findFirst({
      where: eq(Thread.id, threadId),
    });

    if (!thread) {
      // 如果找不到 Thread，返回默认 chatId
      this.logger.warn(`Thread not found in DB, using default chatId: ${threadId}`);
      return PodChatKitStore.DEFAULT_CHAT_ID;
    }

    const chatId = this.extractChatId(thread.chatId);
    // 缓存结果
    this.cacheThreadChatId(context, threadId, chatId);
    return chatId;
  }

  /**
   * 缓存 Thread -> chatId 映射
   */
  private cacheThreadChatId(context: StoreContext, threadId: string, chatId: string): void {
    if (!(context as any)._threadChatIdCache) {
      (context as any)._threadChatIdCache = new Map<string, string>();
    }
    (context as any)._threadChatIdCache.set(threadId, chatId);
  }

  /**
   * 从缓存获取 Thread 的 chatId
   */
  private getCachedThreadChatId(context: StoreContext, threadId: string): string | undefined {
    const cache = (context as any)._threadChatIdCache as Map<string, string> | undefined;
    return cache?.get(threadId);
  }

  /**
   * 缓存完整的 Thread metadata
   */
  private cacheThreadMetadata(context: StoreContext, thread: ThreadMetadata): void {
    if (!(context as any)._threadMetadataCache) {
      (context as any)._threadMetadataCache = new Map<string, ThreadMetadata>();
    }
    (context as any)._threadMetadataCache.set(thread.id, thread);
  }

  /**
   * 从缓存获取 Thread metadata
   */
  private getCachedThreadMetadata(context: StoreContext, threadId: string): ThreadMetadata | undefined {
    const cache = (context as any)._threadMetadataCache as Map<string, ThreadMetadata> | undefined;
    return cache?.get(threadId);
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
  // Thread Operations (ChatKit thread = our Thread)
  // =========================================================================

  async loadThread(threadId: string, context: StoreContext): Promise<ThreadMetadata> {
    // 先从缓存获取
    const cached = this.getCachedThreadMetadata(context, threadId);
    if (cached) {
      return cached;
    }

    const db = await this.getDb(context);
    if (!db) {
      throw new Error('Cannot access Pod: invalid credentials');
    }

    const thread = await db.query.thread.findFirst({
      where: eq(Thread.id, threadId),
    });

    if (!thread) {
      throw new Error(`Thread not found: ${threadId}`);
    }

    const metadata = this.threadRecordToMetadata(thread);
    // 缓存结果
    this.cacheThreadMetadata(context, metadata);
    return metadata;
  }

  async saveThread(thread: ThreadMetadata, context: StoreContext): Promise<void> {
    const db = await this.getDb(context);
    if (!db) {
      throw new Error('Cannot access Pod: invalid credentials');
    }

    const now = new Date().toISOString();

    // 从 metadata 获取 chat_id
    const chatId = this.getChatIdFromMetadata(thread.metadata);
    // Persist all metadata except chat_id (which is derived from storage location).
    const metadataToPersist = { ...(thread.metadata ?? {}) } as Record<string, unknown>;
    delete (metadataToPersist as any).chat_id;
    const metadataJson = Object.keys(metadataToPersist).length > 0 ? JSON.stringify(metadataToPersist) : null;

    // 确保 Chat 容器存在
    await this.ensureChat(chatId, context);

    // 缓存 Thread -> chatId 映射，避免后续查询
    this.cacheThreadChatId(context, thread.id, chatId);

    // 检查 Thread 是否存在
    const existing = await db.query.thread.findFirst({
      where: eq(Thread.id, thread.id),
    });

    if (existing) {
      // Update
      await db.update(Thread).set({
        title: thread.title || null,
        status: this.statusToString(thread.status),
        metadata: metadataJson,
        updatedAt: now,
      }).where(eq(Thread.id, thread.id));
    } else {
      // Insert
      await db.insert(Thread).values({
        id: thread.id,
        chatId,  // 关联到 Chat 容器
        title: thread.title || null,
        status: this.statusToString(thread.status),
        metadata: metadataJson,
        createdAt: new Date(thread.created_at * 1000).toISOString(),
        updatedAt: now,
      });
    }

    // 缓存完整的 Thread metadata，确保 metadata.chat_id 包含正确的值
    const threadMetadata: ThreadMetadata = {
      ...thread,
      metadata: { ...(thread.metadata ?? {}), chat_id: chatId },
    };
    this.cacheThreadMetadata(context, threadMetadata);
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
      const threads = await db.select().from(Thread) as ThreadRecord[];

      // 排序
      threads.sort((a: ThreadRecord, b: ThreadRecord) => {
        const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return order === 'desc' ? bTime - aTime : aTime - bTime;
      });

      // 分页
      let startIndex = 0;
      if (after) {
        const afterIndex = threads.findIndex((t: ThreadRecord) => t.id === after);
        if (afterIndex !== -1) {
          startIndex = afterIndex + 1;
        }
      }

      const slice = threads.slice(startIndex, startIndex + limit);
      const hasMore = startIndex + limit < threads.length;

      return {
        data: slice.map((t: ThreadRecord) => this.threadRecordToMetadata(t)),
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

    // 尝试从缓存获取 chatId
    let chatId = this.getCachedThreadChatId(context, threadId);

    // 如果缓存没有，尝试从数据库查询
    if (!chatId) {
      try {
        const thread = await db.query.thread.findFirst({
          where: eq(Thread.id, threadId),
        });
        if (thread) {
          chatId = this.extractChatId(thread.chatId);
        }
      } catch (err: any) {
        // 忽略查询错误，继续尝试删除
        this.logger.debug(`Ignoring thread query error during delete: ${err.message}`);
      }
    }

    // 删除关联到此 Thread 的消息
    try {
      await db.delete(Message).where(eq(Message.threadId, threadId));
    } catch (err: any) {
      if (!err.message?.includes('404') && !err.message?.includes('Could not retrieve') && !err.message?.includes('Parse error')) {
        throw err;
      }
      this.logger.debug(`Ignoring delete message error: ${err.message}`);
    }

    // 删除 Thread
    try {
      await db.delete(Thread).where(eq(Thread.id, threadId));
    } catch (err: any) {
      if (!err.message?.includes('404') && !err.message?.includes('Could not retrieve') && !err.message?.includes('Parse error')) {
        throw err;
      }
      this.logger.debug(`Ignoring delete thread error: ${err.message}`);
    }

    // 清除缓存
    const metadataCache = (context as any)._threadMetadataCache as Map<string, ThreadMetadata> | undefined;
    const chatIdCache = (context as any)._threadChatIdCache as Map<string, string> | undefined;
    metadataCache?.delete(threadId);
    chatIdCache?.delete(threadId);
  }

  // =========================================================================
  // Thread Item Operations (ChatKit items = our Messages)
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
      // 按 threadId 查询 Message
      const messages = await db.select().from(Message).where(
        eq(Message.threadId, threadId),
      ) as MessageRecord[];

      // 排序
      messages.sort((a: MessageRecord, b: MessageRecord) => {
        const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return order === 'desc' ? bTime - aTime : aTime - bTime;
      });

      // 分页
      let startIndex = 0;
      if (after) {
        const afterIndex = messages.findIndex((m: MessageRecord) => m.id === after);
        if (afterIndex !== -1) {
          startIndex = afterIndex + 1;
        }
      }

      const slice = messages.slice(startIndex, startIndex + limit);
      const hasMore = startIndex + limit < messages.length;

      return {
        data: slice.map((m: MessageRecord) => this.messageRecordToItem(m, threadId)),
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

    // 从 Thread 获取 chatId
    const chatId = await this.getThreadChatId(threadId, context);

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

    const messageRecord = {
      id: item.id,
      chatId,      // 用于路径构建
      threadId,    // 关联到 Thread
      maker: role === MessageRole.USER ? webId : null,
      role,
      content,
      status,
      createdAt: new Date(item.created_at * 1000).toISOString(),
    };

    await db.insert(Message).values(messageRecord);

    // Track this ID to avoid cache timing issues in saveItem
    this.recentlyCreatedIds.add(messageRecord.id);
  }

  // Track recently created message IDs to avoid SELECT cache timing issues
  private recentlyCreatedIds = new Set<string>();

  async saveItem(threadId: string, item: ThreadItem, context: StoreContext): Promise<void> {
    const db = await this.getDb(context);
    if (!db) {
      throw new Error('Cannot access Pod: invalid credentials');
    }

    // 从 Thread 获取 chatId（用于构建资源路径）
    const chatId = await this.getThreadChatId(threadId, context);

    // 准备更新数据
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

    // 获取 createdAt 用于计算资源路径（与 drizzle-solid 模板填充保持一致）
    const createdAt = item.created_at ? new Date(item.created_at * 1000).toISOString() : undefined;

    // 如果是最近创建的消息，使用直接 PATCH 更新（避免 drizzle-solid UPDATE 的 bug）
    const wasRecentlyCreated = this.recentlyCreatedIds.has(item.id);
    if (wasRecentlyCreated) {
      this.recentlyCreatedIds.delete(item.id);
      await this.directPatchMessage(context, chatId, item.id, content, status, createdAt);
      return;
    }

    // 对于非最近创建的消息，使用普通流程
    const existingItems = await db.select().from(Message).where(
      eq(Message.id, item.id),
    ) as MessageRecord[];
    const existing = existingItems.length > 0 ? existingItems[0] : null;

    if (existing) {
      // 使用直接 PATCH 更新
      const existingCreatedAt = existing.createdAt
        ? (existing.createdAt instanceof Date ? existing.createdAt.toISOString() : String(existing.createdAt))
        : undefined;
      await this.directPatchMessage(context, chatId, item.id, content, status, existingCreatedAt);
    } else {
      // Create new record
      await this.addThreadItem(threadId, item, context);
    }
  }

  /**
   * 直接使用 SPARQL UPDATE PATCH 更新消息内容
   * 避免 drizzle-solid UPDATE 的 bug
   */
  private async directPatchMessage(
    context: StoreContext,
    chatId: string,
    messageId: string,
    content: string,
    status: string | null,
    createdAt?: string
  ): Promise<void> {
    // 使用缓存的 fetch 和 webId（由 getDb 时创建的 session）
    const cachedFetch = (context as any)._cachedFetch as typeof fetch | undefined;
    const cachedWebId = (context as any)._cachedWebId as string | undefined;

    if (!cachedFetch || !cachedWebId) {
      throw new Error('No cached session for direct PATCH - call getDb first');
    }

    // 构建资源 URL 和 subject URI
    // Template: {chatId}/{id}.ttl#{id}
    const podBaseUrl = cachedWebId.replace('/profile/card#me', '');
    const resourceUrl = `${podBaseUrl}/.data/chat/${chatId}/${messageId}.ttl`;
    const subjectUri = `${resourceUrl}#${messageId}`;

    // 构建 SPARQL UPDATE：删除旧值，插入新值
    const deletePatterns: string[] = [];
    const insertTriples: string[] = [];

    // 转义特殊字符
    const escapeForSparql = (value: string): string => {
      const hasQuotes = value.includes('"');
      const hasNewlines = value.includes('\n') || value.includes('\r');

      if (hasQuotes || hasNewlines) {
        // 使用三引号
        let escaped = value;
        escaped = escaped.replace(/"""/g, '"\\"\\""');
        if (escaped.endsWith('"')) {
          const match = escaped.match(/"*$/);
          const trailingQuotes = match ? match[0].length : 0;
          if (trailingQuotes > 0) {
            escaped = escaped.slice(0, -trailingQuotes) + '\\"'.repeat(trailingQuotes);
          }
        }
        return `"""${escaped}"""`;
      }
      return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    };

    // Content 更新
    deletePatterns.push(`<${subjectUri}> <http://rdfs.org/sioc/ns#content> ?oldContent .`);
    insertTriples.push(`<${subjectUri}> <http://rdfs.org/sioc/ns#content> ${escapeForSparql(content)} .`);

    // Status 更新
    if (status) {
      deletePatterns.push(`<${subjectUri}> <https://undefineds.co/ns#status> ?oldStatus .`);
      insertTriples.push(`<${subjectUri}> <https://undefineds.co/ns#status> "${status}" .`);
    }

    const sparql = `
DELETE { ${deletePatterns.join(' ')} }
INSERT { ${insertTriples.join(' ')} }
WHERE { ${deletePatterns.join(' ')} }
    `.trim();

    const response = await cachedFetch(resourceUrl, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/sparql-update' },
      body: sparql,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Direct PATCH failed: ${response.status} ${response.statusText} - ${text}`);
    }
  }

  async loadItem(threadId: string, itemId: string, context: StoreContext): Promise<ThreadItem> {
    const db = await this.getDb(context);
    if (!db) {
      throw new Error('Cannot access Pod: invalid credentials');
    }

    const messages = await db.select().from(Message).where(
      and(
        eq(Message.id, itemId),
        eq(Message.threadId, threadId),
      ),
    ) as MessageRecord[];

    if (messages.length === 0) {
      throw new Error(`Item not found: ${itemId}`);
    }

    return this.messageRecordToItem(messages[0], threadId);
  }

  async deleteThreadItem(threadId: string, itemId: string, context: StoreContext): Promise<void> {
    const db = await this.getDb(context);
    if (!db) {
      throw new Error('Cannot access Pod: invalid credentials');
    }

    await db.delete(Message).where(
      and(
        eq(Message.id, itemId),
        eq(Message.threadId, threadId),
      ),
    );
  }

  // =========================================================================
  // Attachment Operations (存 Pod 文件)
  // =========================================================================

  async saveAttachment(attachment: Attachment, _context: StoreContext): Promise<void> {
    this.logger.info(`Attachment saved: ${attachment.id} (${attachment.name})`);
  }

  async loadAttachment(attachmentId: string, _context: StoreContext): Promise<Attachment> {
    throw new Error(`Attachment not found: ${attachmentId}`);
  }

  async deleteAttachment(attachmentId: string, _context: StoreContext): Promise<void> {
    this.logger.info(`Attachment deleted: ${attachmentId}`);
  }

  // =========================================================================
  // AI Config Operations (复用 Session 缓存)
  // =========================================================================

  /**
   * AI 配置结果
   */
  public static readonly AiConfigResult = class {
    providerId!: string;
    baseUrl!: string;
    proxyUrl?: string;
    apiKey!: string;
    credentialId!: string;
  };

  /**
   * 从 Pod 获取 AI 配置（Provider + Credential）
   * 复用已缓存的 Session，避免重复登录
   */
  async getAiConfig(context: StoreContext): Promise<{
    providerId: string;
    baseUrl: string;
    proxyUrl?: string;
    apiKey: string;
    credentialId: string;
  } | undefined> {
    const db = await this.getDb(context);
    if (!db) {
      return undefined;
    }

    try {
      // 查询活跃的 AI 凭据
      const credentials = await db.select()
        .from(Credential)
        .where(and(
          eq(Credential.service, ServiceType.AI),
          eq(Credential.status, CredentialStatus.ACTIVE),
        ));

      if (credentials.length === 0) {
        return undefined;
      }

      // 遍历凭据，找到有效的 Provider
      for (const cred of credentials) {
        if (!cred.provider) continue;

        // 从 URI 提取 provider ID
        const providerId = this.extractProviderId(cred.provider);

        // 查询 Provider
        const providers = await db.select()
          .from(Provider)
          .where(eq(Provider.id, providerId));

        const provider = providers[0];
        if (!provider) continue;

        const baseUrl = cred.baseUrl || provider.baseUrl;
        if (!baseUrl) continue;

        this.logger.debug(`Using credential ${cred.id} with provider ${provider.id}`);

        return {
          providerId: provider.id,
          baseUrl,
          proxyUrl: cred.proxyUrl || provider.proxyUrl || undefined,
          apiKey: cred.apiKey!,
          credentialId: cred.id,
        };
      }

      return undefined;
    } catch (error) {
      this.logger.warn(`Failed to read AI config from Pod: ${error}`);
      return undefined;
    }
  }

  /**
   * 更新凭据状态（如 429 限流）
   * 复用已缓存的 Session
   */
  async updateCredentialStatus(
    context: StoreContext,
    credentialId: string,
    status: CredentialStatus,
    options?: { rateLimitResetAt?: Date; incrementFailCount?: boolean },
  ): Promise<void> {
    const db = await this.getDb(context);
    if (!db) {
      this.logger.debug('Cannot update credential status: no db available');
      return;
    }

    try {
      const updateData: Record<string, any> = { status };

      if (options?.rateLimitResetAt) {
        updateData.rateLimitResetAt = options.rateLimitResetAt;
      }

      // 如果需要递增 failCount，先查询当前值
      if (options?.incrementFailCount) {
        const credentials = await db.select()
          .from(Credential)
          .where(eq(Credential.id, credentialId));

        const currentCred = credentials[0];
        if (currentCred) {
          updateData.failCount = (currentCred.failCount ?? 0) + 1;
        }
      }

      await db.update(Credential)
        .set(updateData)
        .where(eq(Credential.id, credentialId));

      this.logger.info(`Credential ${credentialId} status updated to ${status}`);
    } catch (error) {
      this.logger.error(`Failed to update credential ${credentialId}: ${error}`);
    }
  }

  /**
   * 记录凭据使用成功（重置 failCount，更新 lastUsedAt）
   */
  async recordCredentialSuccess(context: StoreContext, credentialId: string): Promise<void> {
    const db = await this.getDb(context);
    if (!db) {
      return;
    }

    try {
      await db.update(Credential)
        .set({
          lastUsedAt: new Date(),
          failCount: 0,
          status: CredentialStatus.ACTIVE,
          rateLimitResetAt: undefined,
        })
        .where(eq(Credential.id, credentialId));
    } catch (error) {
      this.logger.debug(`Failed to record credential success: ${error}`);
    }
  }

  /**
   * 从 provider URI 提取 ID
   * e.g., "http://localhost:3000/test/settings/ai/providers.ttl#google" -> "google"
   */
  private extractProviderId(providerUri: string): string {
    const hash = providerUri.lastIndexOf('#');
    if (hash >= 0) {
      return providerUri.slice(hash + 1);
    }
    return providerUri;
  }
}
