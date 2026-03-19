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
import { drizzle, eq, and } from '@undefineds.co/drizzle-solid';
import { getLoggerFor } from 'global-logger-factory';
import type { ChatKitStore, StoreContext } from './store';
import type {
  ThreadMetadata,
  ThreadRef,
  ThreadItem,
  Attachment,
  Page,
  StoreItemType,
  UserMessageItem,
  AssistantMessageItem,
  ThreadStatus,
} from './types';
import { generateId, getThreadIdFromRef, nowTimestamp } from './types';
import {
  Chat,
  Thread,
  Message,
  MessageRole,
  MessageStatus,
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

type QueriedMessageRecord = {
  id: string;
  chat?: string | null;
  thread?: string | null;
  maker?: string | null;
  role?: string | null;
  content?: string | null;
  status?: string | null;
  createdAt?: string | Date | null;
  toolName?: string | null;
  toolCallId?: string | null;
  metadata?: string | null;
  subjectUri?: string | null;
};

type ThreadMetadataSource = {
  id: string;
  chatId?: string | null;
  title?: string | null;
  status?: string | null;
  metadata?: string | null;
  createdAt?: string | Date | null;
  updatedAt?: string | Date | null;
};

type ResolvedThreadRef = {
  threadId: string;
  chatId: string;
  threadUri: string;
};

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
  private async getDb(context: StoreContext): Promise<any | null> {
    // Check if we already have a cached db in context
    if ((context as any)._cachedDb) {
      this.logger.debug('Using cached db from context');
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

        this.logger.info(`[getDb] Using access token path for webId: ${auth.webId}`);
        const authFetch = this.createAccessTokenFetch(auth.accessToken, auth.tokenType);
        const db: any = drizzle(
          { fetch: authFetch, info: { webId: auth.webId, isLoggedIn: true } } as any,
          { schema },
        );

        this.logger.info(`Initializing tables for Pod (access token): ${auth.webId}`);
        try {
          await db.init(Chat, Thread, Message);
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

    // Fallback path: exchange client credentials for an access token directly.
    this.logger.info(`[getDb] Using client credentials path for clientId: ${auth.clientId}`);
    try {
      const token = await this.getClientCredentialsAccessToken(auth.clientId, auth.clientSecret);
      const webId = auth.webId ?? this.getWebId(context);
      if (!webId) {
        throw new Error('Missing webId for client credentials auth');
      }

      this.logger.info(`[getDb] Client credentials token acquired, webId: ${webId}`);
      const db: any = drizzle(
        { fetch: this.createAccessTokenFetch(token.accessToken, token.tokenType), info: { webId, isLoggedIn: true } } as any,
        { schema },
      );
      const authFetch = this.createAccessTokenFetch(token.accessToken, token.tokenType);

      this.logger.info(`Initializing tables for Pod: ${webId}`);
      try {
        await db.init(Chat, Thread, Message);
        this.logger.info('Tables initialized successfully');
      } catch (initError) {
        this.logger.error(`Failed to init tables: ${initError}`);
      }

      (context as any)._cachedDb = db;
      (context as any)._cachedFetch = authFetch;
      (context as any)._cachedWebId = webId;
      (context as any)._cachedAccessToken = token.accessToken;
      (context as any)._cachedTokenType = token.tokenType;

      return db;
    } catch (error) {
      this.logger.error(`Failed to get Pod db: ${error}`);
      return null;
    }
  }

  private async getClientCredentialsAccessToken(clientId: string, clientSecret: string): Promise<{
    accessToken: string;
    tokenType: 'Bearer' | 'DPoP';
  }> {
    const response = await fetch(this.tokenEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });

    if (!response.ok) {
      throw new Error(`Client credentials token request failed: ${response.status} ${await response.text().catch(() => '')}`);
    }

    const token = await response.json() as { access_token?: string; token_type?: string };
    if (!token.access_token) {
      throw new Error(`Client credentials token response missing access_token: ${JSON.stringify(token)}`);
    }

    return {
      accessToken: token.access_token,
      tokenType: token.token_type?.toUpperCase() === 'DPOP' ? 'DPoP' : 'Bearer',
    };
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

  private derivePodBaseUrl(webId: string | undefined): string | undefined {
    if (!webId) {
      return undefined;
    }

    try {
      const url = new URL(webId);
      url.hash = '';
      url.search = '';

      const normalizedPath = url.pathname.replace(/\/+$/, '');
      if (!normalizedPath.endsWith('/profile/card')) {
        return undefined;
      }

      const podPath = normalizedPath.slice(0, -'/profile/card'.length) || '/';
      if (podPath === '/') {
        return url.origin;
      }
      url.pathname = podPath;
      return url.toString().replace(/\/$/, '');
    } catch {
      const withoutHash = webId.split('#')[0]?.replace(/\/+$/, '');
      if (!withoutHash?.endsWith('/profile/card')) {
        return undefined;
      }
      const podBase = withoutHash.slice(0, -'/profile/card'.length) || '/';
      if (podBase === '/') {
        try {
          return new URL(webId).origin;
        } catch {
          return undefined;
        }
      }
      return podBase.endsWith('/') ? podBase.slice(0, -1) : podBase;
    }
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
    const existing = await db.findByLocator(Chat, { id: chatId });

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
  private threadRecordToMetadata(record: ThreadMetadataSource, chatUriMap: Map<string, string>): ThreadMetadata {
    const chatId = this.resolveChatIdFromUri(record.chatId, chatUriMap, PodChatKitStore.DEFAULT_CHAT_ID);
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
  private messageRecordToItem(record: QueriedMessageRecord, threadId: string): ThreadItem {
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
   * 获取或构建 chatUri → bare chatId 的映射缓存。
   * drizzle-solid 的 uri() 字段返回完整 URI，通过 Chat 的 @id 比对来还原 bare ID。
   */
  private async getChatUriMap(context: StoreContext): Promise<Map<string, string>> {
    if ((context as any)._chatUriMap) {
      return (context as any)._chatUriMap;
    }
    const db = await this.getDb(context);
    const map = new Map<string, string>();
    if (db) {
      try {
        const chats = await db.select().from(Chat);
        for (const c of chats) {
          const uri = (c as any)['@id'] as string | undefined;
          if (uri) map.set(uri, c.id);
        }
      } catch {
        // ignore
      }
    }
    (context as any)._chatUriMap = map;
    return map;
  }

  /**
   * 从 chatId URI 还原 bare chatId。
   * 优先通过 @id 映射，fallback 处理裸 ID。
   */
  private resolveChatIdFromUri(
    chatIdUri: string | null | undefined,
    chatUriMap: Map<string, string>,
    fallback: string,
  ): string {
    if (!chatIdUri) return fallback;
    const bare = chatUriMap.get(chatIdUri);
    if (bare) return bare;
    // Bare ID passed directly (not a URI)
    return chatIdUri.includes('/') ? fallback : chatIdUri;
  }

  private isAbsoluteHttpIri(value: string): boolean {
    try {
      const url = new URL(value);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  }

  private parseThreadIri(threadIri: string): ResolvedThreadRef | null {
    try {
      const url = new URL(threadIri);
      const match = url.pathname.match(/\/\.data\/chat\/([^/]+)\/index\.ttl$/);
      const threadId = url.hash.startsWith('#') ? decodeURIComponent(url.hash.slice(1)) : '';
      if (!match || !threadId) {
        return null;
      }
      return {
        threadId,
        chatId: decodeURIComponent(match[1]),
        threadUri: url.toString(),
      };
    } catch {
      return null;
    }
  }

  private normalizeThreadCacheKey(thread: ThreadRef): string {
    return getThreadIdFromRef(thread);
  }

  private async buildThreadUri(
    threadId: string,
    chatId: string,
    context: StoreContext,
  ): Promise<string> {
    await this.getDb(context);
    const podBaseUrl = this.getCachedPodBaseUrl(context)
      ?? this.derivePodBaseUrl(this.getWebId(context));
    if (!podBaseUrl) {
      throw new Error('Cannot resolve Pod base URL for thread locator');
    }
    return `${podBaseUrl}/.data/chat/${chatId}/index.ttl#${threadId}`;
  }

  private async resolveThreadRef(
    thread: ThreadRef,
    context: StoreContext,
  ): Promise<ResolvedThreadRef> {
    const threadIdOrIri = thread.thread_id;
    if (this.isAbsoluteHttpIri(threadIdOrIri)) {
      const parsed = this.parseThreadIri(threadIdOrIri);
      if (!parsed) {
        throw new Error(`Invalid thread IRI: ${threadIdOrIri}`);
      }
      this.cacheThreadChatId(context, parsed.threadId, parsed.chatId);
      return parsed;
    }

    if (!('chat_id' in thread) || !thread.chat_id) {
      throw new Error(`chat_id is required when thread_id "${threadIdOrIri}" is not a full thread IRI`);
    }

    const chatId = thread.chat_id;

    const threadUri = await this.buildThreadUri(threadIdOrIri, chatId, context);
    this.cacheThreadChatId(context, threadIdOrIri, chatId);
    return {
      threadId: threadIdOrIri,
      chatId,
      threadUri,
    };
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

  private getCachedFetch(context: StoreContext): typeof fetch | undefined {
    return (context as any)._cachedFetch as typeof fetch | undefined;
  }

  private getCachedPodBaseUrl(context: StoreContext): string | undefined {
    const cachedWebId = (context as any)._cachedWebId as string | undefined;
    return this.derivePodBaseUrl(cachedWebId);
  }

  private extractFragmentId(subjectUri: string): string {
    const hashIndex = subjectUri.lastIndexOf('#');
    if (hashIndex >= 0 && hashIndex < subjectUri.length - 1) {
      return subjectUri.slice(hashIndex + 1);
    }
    const slashIndex = subjectUri.lastIndexOf('/');
    return slashIndex >= 0 && slashIndex < subjectUri.length - 1 ? subjectUri.slice(slashIndex + 1) : subjectUri;
  }

  private parseSparqlBindingValue(binding: Record<string, { value?: string }> | undefined, key: string): string | null {
    return binding?.[key]?.value ?? null;
  }

  private async selectMessagesForThread(
    thread: ThreadRef,
    context: StoreContext,
  ): Promise<QueriedMessageRecord[]> {
    await this.getDb(context);

    const cachedFetch = this.getCachedFetch(context);
    const podBaseUrl = this.getCachedPodBaseUrl(context);
    if (!cachedFetch || !podBaseUrl) {
      return [];
    }

    const resolvedThread = await this.resolveThreadRef(thread, context);
    const endpoint = `${podBaseUrl}/.data/chat/-/sparql`;
    const query = `
      PREFIX meeting: <http://www.w3.org/ns/pim/meeting#>
      PREFIX sioc: <http://rdfs.org/sioc/ns#>
      PREFIX foaf: <http://xmlns.com/foaf/0.1/>
      PREFIX udfs: <https://undefineds.co/ns#>
      SELECT ?msg ?maker ?role ?content ?status ?createdAt ?toolName ?toolCallId ?metadata
      WHERE {
        ?msg a meeting:Message ;
             sioc:has_container <${resolvedThread.threadUri}> .
        OPTIONAL { ?msg foaf:maker ?maker . }
        OPTIONAL { ?msg udfs:role ?role . }
        OPTIONAL { ?msg sioc:content ?content . }
        OPTIONAL { ?msg udfs:status ?status . }
        OPTIONAL { ?msg udfs:createdAt ?createdAt . }
        OPTIONAL { ?msg udfs:toolName ?toolName . }
        OPTIONAL { ?msg udfs:toolCallId ?toolCallId . }
        OPTIONAL { ?msg udfs:metadata ?metadata . }
      }
      ORDER BY ?createdAt
    `.trim();

    const response = await cachedFetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/sparql-query',
        Accept: 'application/sparql-results+json',
      },
      body: query,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Failed to query thread messages: ${response.status} ${response.statusText} - ${text}`);
    }

    const json = await response.json() as {
      results?: {
        bindings?: Array<Record<string, { value?: string }>>;
      };
    };

    const bindings = json.results?.bindings ?? [];
    return bindings.map((binding) => ({
      id: this.extractFragmentId(this.parseSparqlBindingValue(binding, 'msg') ?? ''),
      chat: null,
      thread: resolvedThread.threadUri,
      maker: this.parseSparqlBindingValue(binding, 'maker'),
      role: this.parseSparqlBindingValue(binding, 'role'),
      content: this.parseSparqlBindingValue(binding, 'content'),
      status: this.parseSparqlBindingValue(binding, 'status'),
      createdAt: this.parseSparqlBindingValue(binding, 'createdAt'),
      toolName: this.parseSparqlBindingValue(binding, 'toolName'),
      toolCallId: this.parseSparqlBindingValue(binding, 'toolCallId'),
      metadata: this.parseSparqlBindingValue(binding, 'metadata'),
      subjectUri: this.parseSparqlBindingValue(binding, 'msg'),
    }));
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

  async loadThread(thread: ThreadRef, context: StoreContext): Promise<ThreadMetadata> {
    const cacheKey = this.normalizeThreadCacheKey(thread);
    // 先从缓存获取
    const cached = this.getCachedThreadMetadata(context, cacheKey);
    if (cached) {
      return cached;
    }

    const db = await this.getDb(context);
    if (!db) {
      throw new Error('Cannot access Pod: invalid credentials');
    }

    const resolvedThread = await this.resolveThreadRef(thread, context);
    const threadRecord = await db.findByIri(Thread, resolvedThread.threadUri) as ThreadRecord | null;

    if (!threadRecord) {
      throw new Error(`Thread not found: ${resolvedThread.threadId}`);
    }

    const chatUriMap = await this.getChatUriMap(context);
    const metadata = this.threadRecordToMetadata(threadRecord, chatUriMap);
    // 缓存结果
    this.cacheThreadMetadata(context, metadata);
    this.cacheThreadChatId(context, metadata.id, resolvedThread.chatId);
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
    thread.metadata = { ...(thread.metadata ?? {}), chat_id: chatId };
    // Persist all metadata except chat_id (which is derived from storage location).
    const metadataToPersist = { ...(thread.metadata ?? {}) } as Record<string, unknown>;
    delete (metadataToPersist as any).chat_id;
    const metadataJson = Object.keys(metadataToPersist).length > 0 ? JSON.stringify(metadataToPersist) : null;

    // 确保 Chat 容器存在
    await this.ensureChat(chatId, context);

    // 缓存 Thread -> chatId 映射，避免后续查询
    this.cacheThreadChatId(context, thread.id, chatId);
    const threadUri = await this.buildThreadUri(thread.id, chatId, context);

    // 检查 Thread 是否存在
    const existing = await db.findByIri(Thread, threadUri) as ThreadRecord | null;

    if (existing) {
      // Update
      await db.updateByLocator(Thread, {
        id: thread.id,
        chatId,
      }, {
        title: thread.title || null,
        status: this.statusToString(thread.status),
        metadata: metadataJson,
        updatedAt: now,
      });
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

      const chatUriMap = await this.getChatUriMap(context);

      return {
        data: slice.map((t: ThreadRecord) => this.threadRecordToMetadata(t, chatUriMap)),
        has_more: hasMore,
        after: slice.length > 0 ? slice[slice.length - 1].id : undefined,
      };
    } catch (error) {
      this.logger.error(`Failed to load threads: ${error}`);
      return { data: [], has_more: false };
    }
  }

  async deleteThread(thread: ThreadRef, context: StoreContext): Promise<void> {
    const resolvedThread = await this.resolveThreadRef(thread, context);
    const db = await this.getDb(context);
    if (!db) {
      throw new Error('Cannot access Pod: invalid credentials');
    }

    // 删除关联到此 Thread 的消息
    try {
      await db.delete(Message).where(eq(Message.thread, resolvedThread.threadUri));
    } catch (err: any) {
      if (!err.message?.includes('404') && !err.message?.includes('Could not retrieve') && !err.message?.includes('Parse error')) {
        throw err;
      }
      this.logger.debug(`Ignoring delete message error: ${err.message}`);
    }

    // 删除 Thread
    try {
      await db.deleteByLocator(Thread, {
        id: resolvedThread.threadId,
        chatId: resolvedThread.chatId,
      });
    } catch (err: any) {
      if (!err.message?.includes('404') && !err.message?.includes('Could not retrieve') && !err.message?.includes('Parse error')) {
        throw err;
      }
      this.logger.debug(`Ignoring delete thread error: ${err.message}`);
    }

    // 清除缓存
    const metadataCache = (context as any)._threadMetadataCache as Map<string, ThreadMetadata> | undefined;
    const chatIdCache = (context as any)._threadChatIdCache as Map<string, string> | undefined;
    metadataCache?.delete(resolvedThread.threadId);
    chatIdCache?.delete(resolvedThread.threadId);
  }

  // =========================================================================
  // Thread Item Operations (ChatKit items = our Messages)
  // =========================================================================

  async loadThreadItems(
    thread: ThreadRef,
    after: string | undefined,
    limit: number,
    order: string,
    context: StoreContext,
  ): Promise<Page<ThreadItem>> {
    try {
      const resolvedThread = await this.resolveThreadRef(thread, context);
      const messages = await this.selectMessagesForThread(thread, context);

      // 排序
      messages.sort((a: QueriedMessageRecord, b: QueriedMessageRecord) => {
        const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return order === 'desc' ? bTime - aTime : aTime - bTime;
      });

      // 分页
      let startIndex = 0;
      if (after) {
        const afterIndex = messages.findIndex((m: QueriedMessageRecord) => m.id === after);
        if (afterIndex !== -1) {
          startIndex = afterIndex + 1;
        }
      }

      const slice = messages.slice(startIndex, startIndex + limit);
      const hasMore = startIndex + limit < messages.length;

      return {
        data: slice.map((m: QueriedMessageRecord) => this.messageRecordToItem(m, resolvedThread.threadId)),
        has_more: hasMore,
        after: slice.length > 0 ? slice[slice.length - 1].id : undefined,
      };
    } catch (error) {
      this.logger.error(`Failed to load thread items: ${error}`);
      return { data: [], has_more: false };
    }
  }

  async addThreadItem(thread: ThreadRef, item: ThreadItem, context: StoreContext): Promise<void> {
    const db = await this.getDb(context);
    if (!db) {
      throw new Error('Cannot access Pod: invalid credentials');
    }

    const resolvedThread = await this.resolveThreadRef(thread, context);

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
      chat: resolvedThread.chatId,      // bare ID，用于路径构建
      thread: resolvedThread.threadUri, // 完整 URI，用于 RDF 引用
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

  async saveItem(thread: ThreadRef, item: ThreadItem, context: StoreContext): Promise<void> {
    const db = await this.getDb(context);
    if (!db) {
      throw new Error('Cannot access Pod: invalid credentials');
    }

    const resolvedThread = await this.resolveThreadRef(thread, context);

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
      await this.directPatchMessage(context, resolvedThread.chatId, item.id, content, status, createdAt);
      return;
    }

    // 对于非最近创建的消息，使用普通流程
    const existingItems = (await this.selectMessagesForThread(thread, context))
      .filter((message) => message.id === item.id);
    const existing = existingItems.length > 0 ? existingItems[0] : null;

    if (existing) {
      // 使用直接 PATCH 更新
      const existingCreatedAt = existing.createdAt
        ? (existing.createdAt instanceof Date ? existing.createdAt.toISOString() : String(existing.createdAt))
        : undefined;
      await this.directPatchMessage(context, resolvedThread.chatId, item.id, content, status, existingCreatedAt);
    } else {
      // Create new record
      await this.addThreadItem(thread, item, context);
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
    // Template: {chatId}/{yyyy}/{MM}/{dd}/messages.ttl#{id}
    const podBaseUrl = this.derivePodBaseUrl(cachedWebId);
    if (!podBaseUrl) {
      throw new Error(`Cannot resolve Pod base URL from cached WebID: ${cachedWebId}`);
    }
    const messageDate = createdAt ? new Date(createdAt) : new Date();
    const yyyy = String(messageDate.getUTCFullYear());
    const MM = String(messageDate.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(messageDate.getUTCDate()).padStart(2, '0');
    const resourceUrl = `${podBaseUrl}/.data/chat/${chatId}/${yyyy}/${MM}/${dd}/messages.ttl`;
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

  private async directDeleteMessage(
    context: StoreContext,
    subjectUri?: string | null,
  ): Promise<void> {
    if (!subjectUri) {
      throw new Error('Cannot delete message without subject URI');
    }

    const cachedFetch = (context as any)._cachedFetch as typeof fetch | undefined;
    if (!cachedFetch) {
      throw new Error('No cached session for direct DELETE - call getDb first');
    }

    const hashIndex = subjectUri.lastIndexOf('#');
    const resourceUrl = hashIndex >= 0 ? subjectUri.slice(0, hashIndex) : subjectUri;
    const sparql = `DELETE WHERE { <${subjectUri}> ?p ?o . }`;

    const response = await cachedFetch(resourceUrl, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/sparql-update' },
      body: sparql,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Direct message delete failed: ${response.status} ${response.statusText} - ${text}`);
    }
  }

  async loadItem(thread: ThreadRef, itemId: string, context: StoreContext): Promise<ThreadItem> {
    const db = await this.getDb(context);
    if (!db) {
      throw new Error('Cannot access Pod: invalid credentials');
    }

    const resolvedThread = await this.resolveThreadRef(thread, context);
    const messages = (await this.selectMessagesForThread(thread, context))
      .filter((message) => message.id === itemId);

    if (messages.length === 0) {
      throw new Error(`Item not found: ${itemId}`);
    }

    return this.messageRecordToItem(messages[0], resolvedThread.threadId);
  }

  async deleteThreadItem(thread: ThreadRef, itemId: string, context: StoreContext): Promise<void> {
    const target = (await this.selectMessagesForThread(thread, context))
      .find((message) => message.id === itemId);
    if (!target) {
      return;
    }

    await this.directDeleteMessage(context, target.subjectUri);
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
  private extractProviderId(provider: string): string {
    if (!provider) {
      return '';
    }

    const hashIndex = provider.lastIndexOf('#');
    if (hashIndex >= 0 && hashIndex < provider.length - 1) {
      return provider.slice(hashIndex + 1);
    }

    return provider;
  }

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

      // Build provider @id → record map for URI matching
      const allProviders = await db.select().from(Provider);
      const providerByUri = new Map<string, typeof allProviders[0]>();
      for (const p of allProviders) {
        const uri = (p as any)['@id'] as string | undefined;
        if (uri) providerByUri.set(uri, p);
        // Also index by bare id for fallback
        providerByUri.set(p.id, p);
      }

      // 遍历凭据，找到有效的 Provider
      for (const cred of credentials) {
        if (!cred.provider) continue;

        // Match provider by full URI first, then fallback to bare fragment id.
        const provider = providerByUri.get(cred.provider)
          ?? providerByUri.get(this.extractProviderId(cred.provider));
        if (!provider) continue;

        const baseUrl = provider.baseUrl;
        if (!baseUrl) continue;

        this.logger.debug(`Using credential ${cred.id} with provider ${provider.id}`);

        return {
          providerId: provider.id,
          baseUrl,
          proxyUrl: provider.proxyUrl || undefined,
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
        const currentCred = await db.findByLocator(Credential, { id: credentialId });
        if (currentCred) {
          updateData.failCount = (currentCred.failCount ?? 0) + 1;
        }
      }

      await db.updateByLocator(Credential, { id: credentialId }, updateData);

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
      await db.updateByLocator(Credential, { id: credentialId }, {
        lastUsedAt: new Date(),
        failCount: 0,
        status: CredentialStatus.ACTIVE,
        rateLimitResetAt: undefined,
      });
    } catch (error) {
      this.logger.debug(`Failed to record credential success: ${error}`);
    }
  }

}
