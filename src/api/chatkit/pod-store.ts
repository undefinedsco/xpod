/**
 * Pod-based ChatKit Store
 *
 * 将 ChatKit 数据存储到 Solid Pod。
 *
 * 存储结构:
 * /.data/{chat|task}/{parent-derived-id}/
 *   index.ttl
 *     #this                           # Chat parent (meeting:LongChat)
 *     #{threadId}                     # Thread (sioc:Thread, sioc:has_parent)
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
  ClientToolCallItem,
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
} from './schema';
import {
  Run,
  RunStep,
  type RunRecord,
  type RunStepRecord,
} from '../runs/schema';
import {
  buildRunResourceId,
  buildRunStepResourceId,
  canClaimRun,
  extractResourceLocalId,
  isBaseRelativeResourceId,
  isRunResourceId,
  resolveDataResource as expandDataResource,
  type RunListOptions,
  type RunRecordData,
  type RunStepRecordData,
  type RunStore,
} from '../runs/store';
import {
  Task,
  type TaskRecord,
} from '../tasks/schema';
import {
  buildTaskResourceId,
  resolveTaskResource as expandTaskResource,
  type TaskListOptions,
  type TaskRecordData,
  type TaskStore,
} from '../tasks/store';
import {
  TASK_AUTH_CREDENTIAL_SERVICE,
  type TaskAuthBindingRepository,
  type TaskAuthBindingSnapshot,
} from '../tasks/TaskAuthBinding';
import type { AuthContext } from '../auth/AuthContext';
import { isSolidAuth } from '../auth/AuthContext';
import { Provider } from '../../ai/schema/provider';
import { Model } from '../../ai/schema/model';
import { Credential } from '../../credential/schema/tables';
import { ServiceType, CredentialStatus } from '../../credential/schema/types';
import {
  messageRepository,
  normalizeAIConfigProviderId,
  normalizeAIConfigResourceId,
  threadRepository,
} from '@undefineds.co/models';

const schema = {
  chat: Chat,
  thread: Thread,
  message: Message,
  run: Run,
  runStep: RunStep,
  task: Task,
  provider: Provider,
  model: Model,
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
  metadata?: JsonObjectSource;
  resource?: string | null;
};

type AiCredentialCandidate = {
  id?: string | null;
  provider?: string | null;
  apiKey?: string | null;
  isDefault?: boolean | string | number | null;
  lastUsedAt?: string | Date | number | null;
  failCount?: number | null;
};

type AiConfigSelection = {
  providerId: string;
  baseUrl: string;
  proxyUrl?: string;
  defaultModel?: string;
  apiKey: string;
  credentialId: string;
};

type AiCredentialSparqlCandidate = AiCredentialCandidate & {
  providerId?: string | null;
  baseUrl?: string | null;
  proxyUrl?: string | null;
  defaultModel?: string | null;
};

type JsonObjectSource = string | Record<string, unknown> | null | undefined;

type ThreadMetadataSource = {
  id: string;
  parent?: string | null;
  commandKind?: string | null;
  surfaceId?: string | null;
  chat?: string | null;
  title?: string | null;
  status?: string | null;
  workspace?: string | null;
  metadata?: JsonObjectSource;
  createdAt?: string | Date | null;
  updatedAt?: string | Date | null;
};

type ResolvedThreadRef = {
  threadId: string;
  commandKind: 'chat' | 'task';
  surfaceId: string;
  thread: string;
};

type CommandSurface = {
  commandKind: 'chat' | 'task';
  surfaceId: string;
};

type ThreadParentResolution = CommandSurface & {
  parent: string;
};

type RunRecordSource = {
  id: string;
  surfaceId?: string | null;
  task?: string | null;
  thread?: string | null;
  workspace?: string | null;
  commandKind?: string | null;
  status?: string | null;
  runner?: string | null;
  prompt?: string | null;
  externalRunId?: string | null;
  leaseOwner?: string | null;
  leaseExpiresAt?: string | Date | null;
  heartbeatAt?: string | Date | null;
  cancelRequestedAt?: string | Date | null;
  error?: string | null;
  metadata?: JsonObjectSource;
  createdAt?: string | Date | null;
  startedAt?: string | Date | null;
  completedAt?: string | Date | null;
  updatedAt?: string | Date | null;
};

type TaskRecordSource = {
  id: string;
  surfaceId?: string | null;
  title?: string | null;
  prompt?: string | null;
  thread?: string | null;
  workspace?: string | null;
  runner?: string | null;
  status?: string | null;
  triggerKind?: string | null;
  cron?: string | null;
  intervalSeconds?: number | null;
  eventName?: string | null;
  nextRunAt?: string | Date | null;
  lastRunAt?: string | Date | null;
  metadata?: JsonObjectSource;
  createdAt?: string | Date | null;
  updatedAt?: string | Date | null;
};

type RunStepRecordSource = {
  id: string;
  commandKind?: string | null;
  surfaceId?: string | null;
  runId?: string | null;
  run?: string | null;
  type?: string | null;
  stepType?: string | null;
  message?: string | null;
  data?: JsonObjectSource;
  payload?: JsonObjectSource;
  createdAt?: string | Date | null;
};

/**
 * Pod-based ChatKit Store implementation
 *
 * 数据模型映射：
 * - ChatKit thread = Thread (sioc:Thread)
 * - ChatKit thread item = Message (meeting:Message)
 * - ChatKit 协议里的 chat_id 在内部映射为 surfaceId
 *
 * 每个 Thread 通过 thread.parent 归属到一个命令面：Chat 或 Task。
 * ChatKit 边界保留 chat_id/surface_id 作为协议投影，不作为持久 schema 字段。
 */
export class PodChatKitStore implements ChatKitStore<StoreContext>, RunStore<StoreContext>, TaskStore<StoreContext>, TaskAuthBindingRepository<StoreContext> {
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
          await db.init(Chat, Thread, Message, Run, RunStep, Task, Credential);
          this.logger.info('Tables initialized successfully');
        } catch (initError) {
          this.logger.error(`Failed to init tables: ${initError}`);
        }

        (context as any)._cachedDb = db;
        (context as any)._cachedFetch = authFetch;
        (context as any)._cachedWebId = auth.webId;
        this.ensurePodBaseUrlCache(context, db, auth.webId);
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
        await db.init(Chat, Thread, Message, Run, RunStep, Task, Credential);
        this.logger.info('Tables initialized successfully');
      } catch (initError) {
        this.logger.error(`Failed to init tables: ${initError}`);
      }

      (context as any)._cachedDb = db;
      (context as any)._cachedFetch = authFetch;
      (context as any)._cachedWebId = webId;
      this.ensurePodBaseUrlCache(context, db, webId);
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

  private normalizePodBaseUrl(value: unknown): string | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }

    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }

    return trimmed.replace(/\/+$/, '');
  }

  private readPodUrlFromRuntimeSource(source: unknown): string | undefined {
    if (!source || typeof source !== 'object') {
      return undefined;
    }

    const record = source as Record<string, unknown>;
    const getPodUrl = record.getPodUrl;
    if (typeof getPodUrl === 'function') {
      try {
        const value = getPodUrl.call(source);
        const normalized = this.normalizePodBaseUrl(value);
        if (normalized) {
          return normalized;
        }
      } catch {
        // Ignore and continue with direct properties.
      }
    }

    for (const key of ['podUrl', 'podBaseUrl', 'storageUrl', 'storageProviderUrl']) {
      const normalized = this.normalizePodBaseUrl(record[key]);
      if (normalized) {
        return normalized;
      }
    }

    const runtime = record.runtime;
    if (runtime && runtime !== source) {
      return this.readPodUrlFromRuntimeSource(runtime);
    }

    return undefined;
  }

  private readPodUrlFromDatabase(db: unknown): string | undefined {
    if (!db || typeof db !== 'object') {
      return undefined;
    }

    const record = db as Record<string, unknown>;
    const getDialect = record.getDialect;
    if (typeof getDialect === 'function') {
      try {
        const value = this.readPodUrlFromRuntimeSource(getDialect.call(db));
        if (value) {
          return value;
        }
      } catch {
        // Ignore and continue with session.
      }
    }

    const getSession = record.getSession;
    if (typeof getSession === 'function') {
      try {
        const value = this.readPodUrlFromRuntimeSource(getSession.call(db));
        if (value) {
          return value;
        }
      } catch {
        // Ignore and continue with direct session property.
      }
    }

    return this.readPodUrlFromRuntimeSource(record.session);
  }

  private readExplicitPodBaseUrl(context: StoreContext): string | undefined {
    const record = context as Record<string, unknown>;
    for (const key of ['podBaseUrl', 'podUrl', 'storageUrl', 'storageProviderUrl']) {
      const normalized = this.normalizePodBaseUrl(record[key]);
      if (normalized) {
        return normalized;
      }
    }
    return undefined;
  }

  private ensurePodBaseUrlCache(
    context: StoreContext,
    db?: unknown,
    fallbackWebId?: string,
  ): string | undefined {
    const authoritativePodBaseUrl = this.readExplicitPodBaseUrl(context)
      ?? this.readPodUrlFromDatabase(db);
    if (authoritativePodBaseUrl) {
      (context as any)._cachedPodBaseUrl = authoritativePodBaseUrl;
      return authoritativePodBaseUrl;
    }

    const cached = this.getCachedPodBaseUrl(context);
    if (cached) {
      return cached;
    }

    const podBaseUrl = this.derivePodBaseUrl(fallbackWebId ?? this.getWebId(context));
    if (podBaseUrl) {
      (context as any)._cachedPodBaseUrl = podBaseUrl;
    }

    return podBaseUrl;
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

  private getCommandKindFromMetadata(metadata?: Record<string, unknown>): 'chat' | 'task' {
    return metadata?.commandKind === 'task' ? 'task' : 'chat';
  }

  private getSurfaceIdFromMetadata(metadata?: Record<string, unknown>): string {
    if (metadata && typeof metadata.surface_id === 'string') {
      return metadata.surface_id;
    }
    if (metadata && typeof metadata.chat_id === 'string') {
      return metadata.chat_id;
    }
    return PodChatKitStore.DEFAULT_CHAT_ID;
  }

  private readMetadataString(
    metadata: Record<string, unknown> | undefined,
    key: string,
  ): string | undefined {
    const value = metadata?.[key];
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  }

  private isBaseRelativeChatResourceId(value: string | null | undefined): boolean {
    return typeof value === 'string'
      && !/^https?:\/\//.test(value)
      && !value.startsWith('/')
      && /^[^/]+\/index\.ttl#this$/.test(value);
  }

  private buildChatResourceId(chatId: string): string {
    if (this.isBaseRelativeChatResourceId(chatId)) {
      return chatId;
    }
    return `${chatId.replace(/^#/, '')}/index.ttl#this`;
  }

  private chatSurfaceIdFromResourceId(chatId: string | null | undefined): string | undefined {
    if (!chatId) {
      return undefined;
    }
    const match = chatId.match(/^([^/]+)\/index\.ttl#this$/);
    return match ? decodeURIComponent(match[1]) : undefined;
  }

  private chatSurfaceIdFromResource(chat: string | null | undefined): string | undefined {
    if (!chat) {
      return undefined;
    }
    try {
      const url = new URL(chat);
      const match = url.pathname.match(/\/\.data\/chat\/([^/]+)\/index\.ttl$/);
      if (match && url.hash === '#this') {
        return decodeURIComponent(match[1]);
      }
    } catch {
      // Fall through to base-relative parsing.
    }
    return this.chatSurfaceIdFromResourceId(chat);
  }

  private commandSurfaceFromResourceRef(resource: string | null | undefined): {
    commandKind: 'chat' | 'task';
    surfaceId: string;
  } | undefined {
    if (!resource) {
      return undefined;
    }

    const parseRef = (ref: string, hash?: string): CommandSurface | undefined => {
      const normalizedHash = hash?.startsWith('#') ? hash.slice(1) : hash;
      const trimmed = ref.replace(/^\/+/, '');
      const dataIndex = trimmed.indexOf('.data/');
      const dataRef = dataIndex >= 0 ? trimmed.slice(dataIndex + '.data/'.length) : trimmed;
      const [pathPart, fragmentPart] = dataRef.split('#', 2);
      const fragment = decodeURIComponent(normalizedHash || fragmentPart || '');

      let match = pathPart.match(/^chat\/([^/]+)\/index\.ttl$/);
      if (match && (!fragment || fragment === 'this')) {
        return {
          commandKind: 'chat',
          surfaceId: decodeURIComponent(match[1]),
        };
      }

      match = pathPart.match(/^task\/index\.ttl$/);
      if (match && fragment) {
        return {
          commandKind: 'task',
          surfaceId: fragment,
        };
      }

      match = pathPart.match(/^(chat|task)\/([^/]+)(?:\/|$)/);
      if (match) {
        return {
          commandKind: match[1] === 'task' ? 'task' : 'chat',
          surfaceId: decodeURIComponent(match[2]),
        };
      }

      return undefined;
    };

    try {
      const url = new URL(resource);
      return parseRef(url.pathname, url.hash);
    } catch {
      return parseRef(resource);
    }
  }

  private resolveTaskParentResource(
    taskRef: string,
    context: StoreContext,
  ): string {
    if (/^https?:\/\//.test(taskRef)) {
      return taskRef;
    }
    if (taskRef.startsWith('task/')) {
      return this.resolveDataResource(taskRef, context);
    }
    const podBaseUrl = this.ensurePodBaseUrlCache(context);
    if (!podBaseUrl) {
      throw new Error(`Cannot resolve Pod base URL for task parent: ${taskRef}`);
    }
    return expandTaskResource(podBaseUrl, buildTaskResourceId(taskRef));
  }

  private resolveExplicitThreadParentResource(
    parentRef: string,
    commandKind: 'chat' | 'task',
    context: StoreContext,
  ): string {
    if (/^https?:\/\//.test(parentRef)) {
      return parentRef;
    }
    if (parentRef.startsWith('chat/') || parentRef.startsWith('task/')) {
      return this.resolveDataResource(parentRef, context);
    }
    if (commandKind === 'task') {
      return this.resolveTaskParentResource(parentRef, context);
    }
    return this.resolveDataResource(`chat/${parentRef}/index.ttl#this`, context);
  }

  private resolveThreadParent(
    metadata: Record<string, unknown> | undefined,
    context: StoreContext,
  ): ThreadParentResolution {
    const requestedCommandKind = this.getCommandKindFromMetadata(metadata);
    const requestedSurfaceId = this.getSurfaceIdFromMetadata(metadata);
    const explicitParent = this.readMetadataString(metadata, 'parent');
    const taskRef = requestedCommandKind === 'task'
      ? this.readMetadataString(metadata, 'task') ?? this.readMetadataString(metadata, 'taskId')
      : undefined;

    if (explicitParent) {
      const parent = this.resolveExplicitThreadParentResource(explicitParent, requestedCommandKind, context);
      const surface = this.commandSurfaceFromResourceRef(parent);
      if (surface) {
        return { ...surface, parent };
      }
      return {
        commandKind: requestedCommandKind,
        surfaceId: requestedSurfaceId,
        parent,
      };
    }

    if (requestedCommandKind === 'task') {
      const parent = taskRef
        ? this.resolveTaskParentResource(taskRef, context)
        : this.resolveTaskParentResource(`index.ttl#${requestedSurfaceId}`, context);
      const surface = this.commandSurfaceFromResourceRef(parent);
      return {
        commandKind: 'task',
        surfaceId: surface?.surfaceId ?? requestedSurfaceId,
        parent,
      };
    }

    const parent = this.resolveDataResource(`chat/${requestedSurfaceId}/index.ttl#this`, context);
    return {
      commandKind: 'chat',
      surfaceId: requestedSurfaceId,
      parent,
    };
  }

  private threadApiMetadata(
    metadata: Record<string, unknown> | undefined,
    parent: ThreadParentResolution,
  ): Record<string, unknown> {
    return {
      ...(metadata ?? {}),
      parent: parent.parent,
      chat_id: parent.surfaceId,
      commandKind: parent.commandKind,
      surface_id: parent.surfaceId,
    };
  }

  private threadStoredMetadata(
    metadata: Record<string, unknown> | undefined,
  ): Record<string, unknown> | undefined {
    if (!metadata) {
      return undefined;
    }
    const stored = { ...metadata };
    delete stored.parent;
    delete stored.chat_id;
    delete stored.commandKind;
    delete stored.surface_id;
    return Object.keys(stored).length > 0 ? stored : undefined;
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
    const chatResourceId = this.buildChatResourceId(chatId);
    const surfaceId = this.chatSurfaceIdFromResourceId(chatResourceId) ?? chatId;

    // 检查是否存在
    const existing = await db.findById(Chat, chatResourceId);

    if (!existing) {
      // 创建 Chat 容器
      const now = new Date().toISOString();
      await db.insert(Chat).values({
        id: chatResourceId,
        title: surfaceId === PodChatKitStore.DEFAULT_CHAT_ID ? 'Default Chat' : surfaceId,
        author: webId || null,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
      this.logger.info(`Created Chat container: ${surfaceId}`);
    }
  }

  /**
   * 将 ThreadRecord 转为 ThreadMetadata
   * ChatKit 边界继续暴露 metadata.chat_id；内部同一值叫 surface_id。
   */
  private threadRecordToMetadata(record: ThreadMetadataSource): ThreadMetadata {
    const extra = this.parseJsonObject(record.metadata);
    const parentSurface = this.commandSurfaceFromResourceRef(record.parent);
    const commandKind = parentSurface?.commandKind
      ?? (record.commandKind === 'task' || extra?.commandKind === 'task' ? 'task' : 'chat');
    const surfaceId = parentSurface?.surfaceId
      || record.surfaceId
      || (typeof extra?.surface_id === 'string' ? extra.surface_id : undefined)
      || (typeof extra?.chat_id === 'string' ? extra.chat_id : undefined)
      || this.chatSurfaceIdFromResource(record.chat)
      || PodChatKitStore.DEFAULT_CHAT_ID;
    const parent = record.parent
      ?? (commandKind === 'chat' ? `chat/${surfaceId}/index.ttl#this` : `task/index.ttl#${surfaceId}`);

    return {
      id: record.id,
      title: record.title || undefined,
      status: this.stringToStatus(record.status),
      workspace: record.workspace || undefined,
      created_at: record.createdAt ? Math.floor(new Date(record.createdAt).getTime() / 1000) : nowTimestamp(),
      updated_at: record.updatedAt ? Math.floor(new Date(record.updatedAt).getTime() / 1000) : nowTimestamp(),
      metadata: this.threadApiMetadata(extra, { commandKind, surfaceId, parent }),
    };
  }

  private timestampToIso(timestamp: number | undefined): string | null {
    return typeof timestamp === 'number' ? new Date(timestamp * 1000).toISOString() : null;
  }

  private isoToTimestamp(value: string | Date | null | undefined): number | undefined {
    if (!value) {
      return undefined;
    }
    const date = value instanceof Date ? value : new Date(value);
    const time = date.getTime();
    return Number.isNaN(time) ? undefined : Math.floor(time / 1000);
  }

  private parseJsonObject(value: JsonObjectSource): Record<string, unknown> | undefined {
    if (!value) {
      return undefined;
    }
    if (typeof value === 'object' && !Array.isArray(value)) {
      return value;
    }
    if (typeof value !== 'string') {
      return undefined;
    }
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : undefined;
    } catch {
      return undefined;
    }
  }

  private jsonObjectOrNull(value: Record<string, unknown> | undefined): Record<string, unknown> | null {
    return value && Object.keys(value).length > 0 ? value : null;
  }

  private getXpodMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
    const value = metadata?.xpod;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
  }

  private withXpodMetadata(
    metadata: Record<string, unknown> | undefined,
    xpod: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      ...(metadata ?? {}),
      xpod: {
        ...(this.getXpodMetadata(metadata) ?? {}),
        ...xpod,
      },
    };
  }

  private withoutXpodMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
    if (!metadata) {
      return undefined;
    }
    const result = { ...metadata };
    delete result.xpod;
    return Object.keys(result).length > 0 ? result : undefined;
  }

  private withTaskAuthBindingMetadata(
    metadata: Record<string, unknown> | undefined,
    authBinding: TaskAuthBindingSnapshot | undefined,
  ): Record<string, unknown> | undefined {
    if (!authBinding) {
      return metadata;
    }
    return {
      ...(metadata ?? {}),
      authBinding,
    };
  }

  private parseTaskAuthBinding(value: unknown): TaskAuthBindingSnapshot | undefined {
    if (!value || typeof value !== 'object') {
      return undefined;
    }
    const candidate = value as Partial<TaskAuthBindingSnapshot>;
    if (
      typeof candidate.id !== 'string'
      || typeof candidate.kind !== 'string'
      || typeof candidate.webId !== 'string'
      || typeof candidate.clientId !== 'string'
      || typeof candidate.status !== 'string'
      || typeof candidate.createdAt !== 'number'
    ) {
      return undefined;
    }
    return {
      id: candidate.id,
      kind: candidate.kind as TaskAuthBindingSnapshot['kind'],
      webId: candidate.webId,
      clientId: candidate.clientId,
      displayName: typeof candidate.displayName === 'string' ? candidate.displayName : undefined,
      status: candidate.status as TaskAuthBindingSnapshot['status'],
      createdAt: candidate.createdAt,
      expiresAt: typeof candidate.expiresAt === 'number' ? candidate.expiresAt : undefined,
    };
  }

  private isBaseRelativeDataResourceId(value: string | null | undefined): value is string {
    return typeof value === 'string'
      && !/^https?:\/\//.test(value)
      && !value.startsWith('/')
      && value.includes('#')
      && !value.startsWith('#');
  }

  private isResourceLikeId(value: string | null | undefined): value is string {
    return typeof value === 'string'
      && !/^https?:\/\//.test(value)
      && !value.startsWith('/')
      && !value.startsWith('#')
      && (value.includes('/') || /\.ttl(?:#|$)/i.test(value) || value.includes('#'));
  }

  private isThreadResourceId(value: string | null | undefined): value is string {
    return typeof value === 'string'
      && /^(chat|task)\/[^/]+\/index\.ttl#[^#/]+$/.test(value);
  }

  private isMessageResourceId(value: string | null | undefined): value is string {
    return typeof value === 'string'
      && /^(chat|task)\/[^/]+\/\d{4}\/\d{2}\/\d{2}\/messages\.ttl#[^#/]+$/.test(value);
  }

  private buildThreadResourceId(input: {
    id: string;
    commandKind: 'chat' | 'task';
    surfaceId: string;
  }): string {
    void input.commandKind;
    void input.surfaceId;
    if (!this.isThreadResourceId(input.id)) {
      throw new Error(`Thread id must be a complete Thread resource id: ${input.id}`);
    }
    return input.id;
  }

  private generateThreadResourceId(input: {
    key: string;
    commandKind: 'chat' | 'task';
    surfaceId: string;
  }): string {
    if (isBaseRelativeResourceId(input.key)) {
      throw new Error(`Thread id generator requires a local key, got resource id: ${input.key}`);
    }
    if (this.isResourceLikeId(input.key)) {
      throw new Error(`Thread id generator requires a local key: ${input.key}`);
    }
    return `${input.commandKind}/${input.surfaceId}/index.ttl#${extractResourceLocalId(input.key)}`;
  }

  private buildMessageResourceId(input: {
    id: string;
    commandKind: 'chat' | 'task';
    surfaceId: string;
    createdAt?: number;
  }): string {
    void input.commandKind;
    void input.surfaceId;
    void input.createdAt;
    if (!this.isMessageResourceId(input.id)) {
      throw new Error(`Message id must be a complete Message resource id: ${input.id}`);
    }
    return input.id;
  }

  private generateMessageResourceId(input: {
    key: string;
    commandKind: 'chat' | 'task';
    surfaceId: string;
    createdAt?: number;
  }): string {
    if (isBaseRelativeResourceId(input.key)) {
      throw new Error(`Message id generator requires a local key, got resource id: ${input.key}`);
    }
    if (this.isResourceLikeId(input.key)) {
      throw new Error(`Message id generator requires a local key: ${input.key}`);
    }
    const { yyyy, MM, dd } = this.datePathFromTimestamp(input.createdAt);
    return `${input.commandKind}/${input.surfaceId}/${yyyy}/${MM}/${dd}/messages.ttl#${extractResourceLocalId(input.key)}`;
  }

  private resolveDataResource(resourceId: string, context: StoreContext): string {
    if (/^https?:\/\//.test(resourceId)) {
      return resourceId;
    }
    const podBaseUrl = this.ensurePodBaseUrlCache(context);
    if (!podBaseUrl) {
      throw new Error(`Cannot resolve Pod base URL for resource id: ${resourceId}`);
    }
    return expandDataResource(podBaseUrl, resourceId);
  }

  private baseRelativeIdFromResource(resource: string, context: StoreContext): string {
    const podBaseUrl = this.ensurePodBaseUrlCache(context);
    if (podBaseUrl) {
      const dataPrefix = `${podBaseUrl.replace(/\/$/, '')}/.data/`;
      if (resource.startsWith(dataPrefix)) {
        return resource.slice(dataPrefix.length);
      }
    }
    const marker = '/.data/';
    const markerIndex = resource.indexOf(marker);
    if (markerIndex >= 0) {
      return resource.slice(markerIndex + marker.length);
    }
    return resource;
  }

  private baseRelativeIdFromPodPath(resource: string, context: StoreContext, podPath: string): string {
    const normalizedPath = podPath.replace(/^\/+|\/+$/g, '');
    const podBaseUrl = this.ensurePodBaseUrlCache(context);

    if (podBaseUrl) {
      const prefix = `${podBaseUrl.replace(/\/$/, '')}/${normalizedPath}/`;
      if (resource.startsWith(prefix)) {
        return resource.slice(prefix.length);
      }
    }

    const marker = `/${normalizedPath}/`;
    const markerIndex = resource.indexOf(marker);
    if (markerIndex >= 0) {
      return resource.slice(markerIndex + marker.length);
    }
    return resource;
  }

  private runRecordToData(record: RunRecordSource): RunRecordData {
    const metadata = this.parseJsonObject(record.metadata);
    const xpod = this.getXpodMetadata(metadata);
    const surface = this.commandSurfaceFromResourceRef(record.id);
    return {
      id: record.id || '',
      surfaceId: surface?.surfaceId || record.surfaceId || (typeof xpod?.surfaceId === 'string' ? xpod.surfaceId : 'default'),
      task: record.task || undefined,
      thread: record.thread || '',
      workspace: record.workspace || '',
      commandKind: surface?.commandKind ?? (record.commandKind === 'task' || xpod?.commandKind === 'task' ? 'task' : 'chat'),
      status: (record.status || 'queued') as RunRecordData['status'],
      runner: record.runner || '',
      prompt: record.prompt || undefined,
      externalRunId: record.externalRunId || undefined,
      leaseOwner: record.leaseOwner || undefined,
      leaseExpiresAt: this.isoToTimestamp(record.leaseExpiresAt),
      heartbeatAt: this.isoToTimestamp(record.heartbeatAt),
      cancelRequestedAt: this.isoToTimestamp(record.cancelRequestedAt),
      error: record.error || undefined,
      metadata,
      createdAt: this.isoToTimestamp(record.createdAt) ?? nowTimestamp(),
      startedAt: this.isoToTimestamp(record.startedAt),
      completedAt: this.isoToTimestamp(record.completedAt),
      updatedAt: this.isoToTimestamp(record.updatedAt) ?? nowTimestamp(),
    };
  }

  private runStepRecordToData(record: RunStepRecordSource, context: StoreContext): RunStepRecordData {
    const payload = this.parseJsonObject(record.payload) ?? this.parseJsonObject(record.data);
    const xpod = this.getXpodMetadata(payload);
    const runId = record.runId
      || (record.run ? this.baseRelativeIdFromResource(record.run, context) : '')
      || (typeof xpod?.runId === 'string' ? xpod.runId : '');
    const surface = this.commandSurfaceFromResourceRef(runId);
    return {
      id: record.id || '',
      commandKind: surface?.commandKind ?? (record.commandKind === 'task' || xpod?.commandKind === 'task' ? 'task' : 'chat'),
      surfaceId: surface?.surfaceId || record.surfaceId || (typeof xpod?.surfaceId === 'string' ? xpod.surfaceId : 'default'),
      runId,
      run: record.run || '',
      type: record.type || record.stepType || 'runtime.event',
      message: record.message || undefined,
      data: this.withoutXpodMetadata(payload),
      createdAt: this.isoToTimestamp(record.createdAt) ?? nowTimestamp(),
    };
  }

  private taskRecordToData(record: TaskRecordSource): TaskRecordData {
    const metadata = this.parseJsonObject(record.metadata);
    const xpod = this.getXpodMetadata(metadata);
    return {
      id: record.id || '',
      surfaceId: record.surfaceId || (typeof xpod?.surfaceId === 'string' ? xpod.surfaceId : 'default'),
      title: record.title || undefined,
      prompt: record.prompt || '',
      thread: record.thread || '',
      workspace: record.workspace || '',
      runner: record.runner || (typeof xpod?.runner === 'string' ? xpod.runner : ''),
      status: (record.status || 'active') as TaskRecordData['status'],
      triggerKind: (record.triggerKind || xpod?.triggerKind || 'once') as TaskRecordData['triggerKind'],
      cron: record.cron || (typeof xpod?.cron === 'string' ? xpod.cron : undefined),
      intervalSeconds: typeof record.intervalSeconds === 'number'
        ? record.intervalSeconds
        : (typeof xpod?.intervalSeconds === 'number' ? xpod.intervalSeconds : undefined),
      eventName: record.eventName || (typeof xpod?.eventName === 'string' ? xpod.eventName : undefined),
      nextRunAt: this.isoToTimestamp(record.nextRunAt) ?? (typeof xpod?.nextRunAt === 'number' ? xpod.nextRunAt : undefined),
      lastRunAt: this.isoToTimestamp(record.lastRunAt) ?? (typeof xpod?.lastRunAt === 'number' ? xpod.lastRunAt : undefined),
      authBinding: this.parseTaskAuthBinding(metadata?.authBinding),
      metadata,
      createdAt: this.isoToTimestamp(record.createdAt) ?? nowTimestamp(),
      updatedAt: this.isoToTimestamp(record.updatedAt) ?? nowTimestamp(),
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
    }

    if (record.role === MessageRole.SYSTEM && record.toolName) {
      const metadata = this.parseJsonObject(record.metadata) ?? {};
      return {
        id: record.id,
        thread_id: threadId,
        type: 'client_tool_call',
        name: record.toolName,
        arguments: typeof metadata.arguments === 'string' ? metadata.arguments : '',
        call_id: record.toolCallId || '',
        status: (record.status === 'completed' ? 'completed' : 'pending') as ClientToolCallItem['status'],
        output: typeof metadata.output === 'string' ? metadata.output : undefined,
        metadata,
        created_at: createdAt,
      } as ClientToolCallItem;
    }

    {
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

  private isAbsoluteHttpResource(value: string): boolean {
    try {
      const url = new URL(value);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  }

  private parseThreadResource(thread: string): ResolvedThreadRef | null {
    try {
      const url = new URL(thread);
      const match = url.pathname.match(/\/\.data\/(chat|task)\/([^/]+)\/index\.ttl$/);
      const localThreadId = url.hash.startsWith('#') ? decodeURIComponent(url.hash.slice(1)) : '';
      if (!match || !localThreadId) {
        return null;
      }
      const commandKind = match[1] === 'task' ? 'task' : 'chat';
      const surfaceId = decodeURIComponent(match[2]);
      return {
        threadId: `${commandKind}/${surfaceId}/index.ttl#${localThreadId}`,
        commandKind,
        surfaceId,
        thread: url.toString(),
      };
    } catch {
      return null;
    }
  }

  private normalizeThreadCacheKey(thread: ThreadRef): string {
    return getThreadIdFromRef(thread);
  }

  private parseThreadResourceId(threadId: string): Omit<ResolvedThreadRef, 'thread'> | null {
    const match = threadId.match(/^(chat|task)\/([^/]+)\/index\.ttl#(.+)$/);
    if (!match) {
      return null;
    }
    const commandKind = match[1] === 'task' ? 'task' : 'chat';
    const surfaceId = decodeURIComponent(match[2]);
    return {
      threadId,
      commandKind,
      surfaceId,
    };
  }

  private async resolveThreadRef(
    thread: ThreadRef,
    context: StoreContext,
  ): Promise<ResolvedThreadRef> {
    const threadRef = thread.thread_id;
    if (this.isAbsoluteHttpResource(threadRef)) {
      const parsed = this.parseThreadResource(threadRef);
      if (!parsed) {
        throw new Error(`Invalid thread resource: ${threadRef}`);
      }
      this.cacheThreadSurfaceId(context, parsed.threadId, parsed.surfaceId);
      return parsed;
    }

    const parsedResourceId = this.parseThreadResourceId(threadRef);
    if (parsedResourceId) {
      const threadResource = this.resolveDataResource(parsedResourceId.threadId, context);
      this.cacheThreadSurfaceId(context, parsedResourceId.threadId, parsedResourceId.surfaceId);
      return {
        ...parsedResourceId,
        thread: threadResource,
      };
    }

    if (!('chat_id' in thread) || !thread.chat_id) {
      throw new Error(`chat_id is required when thread_id "${threadRef}" is not a full thread resource id`);
    }

    const surfaceId = thread.chat_id;
    const commandKind = 'chat';
    const threadId = this.generateThreadResourceId({
      key: threadRef,
      commandKind,
      surfaceId,
    });

    const threadResource = this.resolveDataResource(threadId, context);
    this.cacheThreadSurfaceId(context, threadId, surfaceId);
    return {
      threadId,
      commandKind,
      surfaceId,
      thread: threadResource,
    };
  }

  /**
   * 缓存 Thread -> surfaceId 映射
   */
  private cacheThreadSurfaceId(context: StoreContext, threadId: string, surfaceId: string): void {
    if (!(context as any)._threadSurfaceIdCache) {
      (context as any)._threadSurfaceIdCache = new Map<string, string>();
    }
    (context as any)._threadSurfaceIdCache.set(threadId, surfaceId);
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

  private getCachedThreadMetadataList(context: StoreContext): ThreadMetadata[] {
    const cache = (context as any)._threadMetadataCache as Map<string, ThreadMetadata> | undefined;
    return cache ? Array.from(cache.values()) : [];
  }

  private getCachedFetch(context: StoreContext): typeof fetch | undefined {
    return (context as any)._cachedFetch as typeof fetch | undefined;
  }

  private getCachedPodBaseUrl(context: StoreContext): string | undefined {
    const cachedPodBaseUrl = (context as any)._cachedPodBaseUrl as string | undefined;
    if (cachedPodBaseUrl) {
      return cachedPodBaseUrl.replace(/\/$/, '');
    }
    return undefined;
  }

  private parseSparqlBindingValue(binding: Record<string, { value?: string }> | undefined, key: string): string | null {
    return binding?.[key]?.value ?? null;
  }

  private async selectMessagesForThread(
    thread: ThreadRef,
    context: StoreContext,
  ): Promise<QueriedMessageRecord[]> {
    const db = await this.getDb(context);
    if (!db) {
      return [];
    }

    const resolvedThread = await this.resolveThreadRef(thread, context);

    const records = await messageRepository.list(db, {
      thread: resolvedThread.thread,
    }) as Array<{
      id?: string | null;
      chat?: string | null;
      thread?: string | null;
      maker?: string | null;
      role?: string | null;
      content?: string | null;
      status?: string | null;
      createdAt?: string | Date | null;
      toolName?: string | null;
      toolCallId?: string | null;
      metadata?: JsonObjectSource;
    }>;

    return records.map((record) => ({
      id: record.id || '',
      chat: record.chat || null,
      thread: record.thread || resolvedThread.thread,
      maker: record.maker || null,
      role: record.role || null,
      content: record.content || null,
      status: record.status || null,
      createdAt: record.createdAt || null,
      toolName: record.toolName || null,
      toolCallId: record.toolCallId || null,
      metadata: record.metadata || null,
      resource: record.id ? this.resolveDataResource(record.id, context) : null,
    }));
  }

  private datePathFromTimestamp(timestamp: number | undefined): { yyyy: string; MM: string; dd: string } {
    const date = typeof timestamp === 'number' ? new Date(timestamp * 1000) : new Date();
    return {
      yyyy: String(date.getUTCFullYear()),
      MM: String(date.getUTCMonth() + 1).padStart(2, '0'),
      dd: String(date.getUTCDate()).padStart(2, '0'),
    };
  }

  // =========================================================================
  // ID Generation
  // =========================================================================

  generateThreadId(_context: StoreContext): string {
    return this.generateThreadResourceId({
      key: generateId('thread'),
      commandKind: 'chat',
      surfaceId: PodChatKitStore.DEFAULT_CHAT_ID,
    });
  }

  generateItemId(itemType: StoreItemType, thread: ThreadMetadata, _context: StoreContext): string {
    const commandKind = thread.metadata?.commandKind === 'task' ? 'task' : 'chat';
    const surfaceId = this.getSurfaceIdFromMetadata(thread.metadata);
    return this.generateMessageResourceId({
      key: generateId(itemType.replace('_', '-')),
      commandKind,
      surfaceId,
    });
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
    const threadRecord = await db.findByIri(Thread, resolvedThread.thread) as ThreadRecord | null;

    if (!threadRecord) {
      throw new Error(`Thread not found: ${resolvedThread.threadId}`);
    }

    const metadata = this.threadRecordToMetadata(threadRecord);
    // 缓存结果
    this.cacheThreadMetadata(context, metadata);
    this.cacheThreadSurfaceId(context, metadata.id, this.getSurfaceIdFromMetadata(metadata.metadata));
    return metadata;
  }

  async saveThread(thread: ThreadMetadata, context: StoreContext): Promise<void> {
    const db = await this.getDb(context);
    if (!db) {
      throw new Error('Cannot access Pod: invalid credentials');
    }

    const now = new Date().toISOString();

    const parent = this.resolveThreadParent(thread.metadata, context);
    const commandKind = parent.commandKind;
    const surfaceId = parent.surfaceId;
    const apiMetadata = this.threadApiMetadata(thread.metadata, parent);
    thread.metadata = apiMetadata;
    const metadataObject = this.jsonObjectOrNull(this.threadStoredMetadata(apiMetadata));

    if (commandKind === 'chat') {
      await this.ensureChat(surfaceId, context);
    }

    const threadResourceId = this.buildThreadResourceId({
      id: thread.id,
      commandKind,
      surfaceId,
    });
    thread.id = threadResourceId;
    this.cacheThreadSurfaceId(context, thread.id, surfaceId);
    const threadResource = this.resolveDataResource(threadResourceId, context);

    // 检查 Thread 是否存在
    const existing = await db.findByIri(Thread, threadResource) as ThreadRecord | null;

    if (existing) {
      // Update
      await db.updateByIri(Thread, threadResource, {
        parent: parent.parent,
        title: thread.title || null,
        status: this.statusToString(thread.status),
        workspace: thread.workspace || null,
        metadata: metadataObject,
        updatedAt: now,
      });
    } else {
      // Insert
      await db.insert(Thread).values({
        id: threadResourceId,
        parent: parent.parent,
        title: thread.title || null,
        status: this.statusToString(thread.status),
        workspace: thread.workspace || null,
        metadata: metadataObject,
        createdAt: new Date(thread.created_at * 1000).toISOString(),
        updatedAt: now,
      });
    }

    // 缓存完整的 Thread metadata，确保 ChatKit metadata.chat_id 包含正确的 surface。
    const threadMetadata: ThreadMetadata = {
      ...thread,
      metadata: apiMetadata,
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
      const threads = await threadRepository.list(db) as ThreadRecord[];
      const metadataById = new Map<string, ThreadMetadata>();
      for (const thread of threads) {
        const metadata = this.threadRecordToMetadata(thread);
        metadataById.set(metadata.id, metadata);
      }
      for (const cached of this.getCachedThreadMetadataList(context)) {
        metadataById.set(cached.id, cached);
      }
      const threadMetadata = Array.from(metadataById.values());

      // 排序
      threadMetadata.sort((a: ThreadMetadata, b: ThreadMetadata) => {
        const aTime = (a.created_at ?? 0) * 1000;
        const bTime = (b.created_at ?? 0) * 1000;
        return order === 'desc' ? bTime - aTime : aTime - bTime;
      });

      // 分页
      let startIndex = 0;
      if (after) {
        const afterIndex = threadMetadata.findIndex((t: ThreadMetadata) => t.id === after);
        if (afterIndex !== -1) {
          startIndex = afterIndex + 1;
        }
      }

      const slice = threadMetadata.slice(startIndex, startIndex + limit);
      const hasMore = startIndex + limit < threadMetadata.length;

      return {
        data: slice,
        has_more: hasMore,
        after: slice.length > 0 ? slice[slice.length - 1].id : undefined,
      };
    } catch (error) {
      this.logger.error(`Failed to load threads: ${error}`);
      const cached = this.getCachedThreadMetadataList(context);
      return { data: cached.slice(0, limit), has_more: cached.length > limit };
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
      await db.delete(Message).where(eq(Message.thread, resolvedThread.thread));
    } catch (err: any) {
      if (!err.message?.includes('404') && !err.message?.includes('Could not retrieve') && !err.message?.includes('Parse error')) {
        throw err;
      }
      this.logger.debug(`Ignoring delete message error: ${err.message}`);
    }

    // 删除 Thread
    try {
      await db.deleteByIri(Thread, resolvedThread.thread);
    } catch (err: any) {
      if (!err.message?.includes('404') && !err.message?.includes('Could not retrieve') && !err.message?.includes('Parse error')) {
        throw err;
      }
      this.logger.debug(`Ignoring delete thread error: ${err.message}`);
    }

    // 清除缓存
    const metadataCache = (context as any)._threadMetadataCache as Map<string, ThreadMetadata> | undefined;
    const surfaceIdCache = (context as any)._threadSurfaceIdCache as Map<string, string> | undefined;
    metadataCache?.delete(resolvedThread.threadId);
    surfaceIdCache?.delete(resolvedThread.threadId);
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
    const itemResourceId = this.buildMessageResourceId({
      id: item.id,
      commandKind: resolvedThread.commandKind,
      surfaceId: resolvedThread.surfaceId,
      createdAt: item.created_at,
    });
    item.id = itemResourceId;
    item.thread_id = resolvedThread.threadId;

    const webId = this.getWebId(context);
    let content = '';
    let role: string = MessageRole.USER;
    let status: string = MessageStatus.COMPLETED;
    let toolName: string | null = null;
    let toolCallId: string | null = null;
    let metadata: Record<string, unknown> | null = null;

    if (item.type === 'user_message') {
      const userItem = item as UserMessageItem;
      content = userItem.content
        .filter((c) => c.type === 'input_text')
        .map((c) => (c as any).text)
        .join('\n');
      role = MessageRole.USER;
      status = MessageStatus.SENT;
    } else if (item.type === 'assistant_message') {
      const assistantItem = item as AssistantMessageItem;
      content = assistantItem.content
        .filter((c) => c.type === 'output_text')
        .map((c) => c.text)
        .join('\n');
      role = MessageRole.ASSISTANT;
      status = assistantItem.status || MessageStatus.COMPLETED;
    } else if (item.type === 'client_tool_call') {
      const toolItem = item as ClientToolCallItem;
      content = toolItem.output ?? '';
      role = MessageRole.SYSTEM;
      status = toolItem.status ?? 'pending';
      toolName = toolItem.name;
      toolCallId = toolItem.call_id;
      metadata = {
        ...(toolItem.metadata ?? {}),
        arguments: toolItem.arguments,
        output: toolItem.output,
      };
    } else {
      // 其他类型暂时存储为 JSON
      content = JSON.stringify(item);
      role = MessageRole.SYSTEM;
      status = MessageStatus.COMPLETED;
    }

    const messageRecord = {
      id: itemResourceId,
      chat: resolvedThread.commandKind === 'chat' ? this.buildChatResourceId(resolvedThread.surfaceId) : null,
      thread: resolvedThread.thread,
      maker: role === MessageRole.USER ? webId : null,
      role,
      content,
      status,
      toolName,
      toolCallId,
      metadata: this.jsonObjectOrNull({
        ...(metadata ?? {}),
        commandKind: resolvedThread.commandKind,
        surface_id: resolvedThread.surfaceId,
        chat_id: resolvedThread.surfaceId,
      }),
      createdAt: new Date(item.created_at * 1000).toISOString(),
    };

    await db.insert(Message).values(messageRecord);

    // Track this ID to avoid cache timing issues in saveItem
    this.recentlyCreatedIds.add(item.id);
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
    let metadata: Record<string, unknown> | null = null;

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
    } else if (item.type === 'client_tool_call') {
      const toolItem = item as ClientToolCallItem;
      content = toolItem.output ?? '';
      status = toolItem.status ?? 'pending';
      metadata = {
        ...(toolItem.metadata ?? {}),
        arguments: toolItem.arguments,
        output: toolItem.output,
      };
    }

    const itemResourceId = this.buildMessageResourceId({
      id: item.id,
      commandKind: resolvedThread.commandKind,
      surfaceId: resolvedThread.surfaceId,
      createdAt: item.created_at,
    });

    // 如果是最近创建的消息，使用直接 PATCH 更新（避免 drizzle-solid UPDATE 的 bug）
    const wasRecentlyCreated = this.recentlyCreatedIds.has(itemResourceId);
    if (wasRecentlyCreated) {
      this.recentlyCreatedIds.delete(itemResourceId);
      item.id = itemResourceId;
      item.thread_id = resolvedThread.threadId;
      await this.directPatchMessage(context, itemResourceId, content, status, metadata);
      return;
    }

    // 对于非最近创建的消息，使用普通流程
    const existingItems = (await this.selectMessagesForThread(thread, context))
      .filter((message) => message.id === itemResourceId);
    const existing = existingItems.length > 0 ? existingItems[0] : null;

    if (existing) {
      // 使用直接 PATCH 更新
      item.id = itemResourceId;
      item.thread_id = resolvedThread.threadId;
      await this.directPatchMessage(context, existing.id, content, status, metadata);
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
    messageResourceId: string,
    content: string,
    status: string | null,
    metadata: Record<string, unknown> | null = null,
  ): Promise<void> {
    // 使用缓存的 fetch 和 webId（由 getDb 时创建的 session）
    const cachedFetch = (context as any)._cachedFetch as typeof fetch | undefined;

    if (!cachedFetch) {
      throw new Error('No cached session for direct PATCH - call getDb first');
    }

    const messageResource = this.resolveDataResource(messageResourceId, context);
    const hashIndex = messageResource.lastIndexOf('#');
    const resourceUrl = hashIndex >= 0 ? messageResource.slice(0, hashIndex) : messageResource;

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
    deletePatterns.push(`<${messageResource}> <http://rdfs.org/sioc/ns#content> ?oldContent .`);
    insertTriples.push(`<${messageResource}> <http://rdfs.org/sioc/ns#content> ${escapeForSparql(content)} .`);

    // Status 更新
    if (status) {
      deletePatterns.push(`<${messageResource}> <https://undefineds.co/ns#messageStatus> ?oldStatus .`);
      insertTriples.push(`<${messageResource}> <https://undefineds.co/ns#messageStatus> "${status}" .`);
    }

    if (metadata) {
      deletePatterns.push(`<${messageResource}> <https://undefineds.co/ns#metadata> ?oldMetadata .`);
      insertTriples.push(`<${messageResource}> <https://undefineds.co/ns#metadata> ${escapeForSparql(JSON.stringify(metadata))} .`);
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
    resource?: string | null,
  ): Promise<void> {
    if (!resource) {
      throw new Error('Cannot delete message without resource');
    }

    const cachedFetch = (context as any)._cachedFetch as typeof fetch | undefined;
    if (!cachedFetch) {
      throw new Error('No cached session for direct DELETE - call getDb first');
    }

    const hashIndex = resource.lastIndexOf('#');
    const resourceUrl = hashIndex >= 0 ? resource.slice(0, hashIndex) : resource;
    const sparql = `DELETE WHERE { <${resource}> ?p ?o . }`;

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

    await this.directDeleteMessage(context, target.resource);
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
  // Run Operations
  // =========================================================================

  async saveRun(run: RunRecordData, context: StoreContext): Promise<void> {
    const db = await this.getDb(context);
    if (!db) {
      throw new Error('Cannot access Pod: invalid credentials');
    }

    run.id = buildRunResourceId(run);
    const existing = await db.findById(Run, run.id) as RunRecord | null;
    const values = {
      task: run.task || null,
      thread: run.thread,
      workspace: run.workspace,
      status: run.status,
      runner: run.runner || null,
      prompt: run.prompt || null,
      externalRunId: run.externalRunId || null,
      leaseOwner: run.leaseOwner || null,
      leaseExpiresAt: this.timestampToIso(run.leaseExpiresAt),
      heartbeatAt: this.timestampToIso(run.heartbeatAt),
      cancelRequestedAt: this.timestampToIso(run.cancelRequestedAt),
      error: run.error || null,
      metadata: this.jsonObjectOrNull(run.metadata),
      createdAt: this.timestampToIso(run.createdAt) ?? new Date().toISOString(),
      startedAt: this.timestampToIso(run.startedAt),
      completedAt: this.timestampToIso(run.completedAt),
      updatedAt: this.timestampToIso(run.updatedAt) ?? new Date().toISOString(),
    };

    if (existing) {
      await db.updateById(Run, run.id, values);
      return;
    }

    await db.insert(Run).values({
      id: run.id,
      ...values,
    });
  }

  async loadRun(id: string, context: StoreContext): Promise<RunRecordData> {
    const db = await this.getDb(context);
    if (!db) {
      throw new Error('Cannot access Pod: invalid credentials');
    }
    const record = await db.findById(Run, id) as RunRecord | null;
    if (!record) {
      throw new Error(`Run not found: ${id}`);
    }
    return this.runRecordToData(record);
  }

  async listRuns(options: RunListOptions, context: StoreContext): Promise<RunRecordData[]> {
    const db = await this.getDb(context);
    if (!db) {
      throw new Error('Cannot access Pod: invalid credentials');
    }

    const conditions = [];
    if (options.task) {
      conditions.push(eq(Run.task, options.task));
    }
    if (options.thread) {
      conditions.push(eq(Run.thread, options.thread));
    }
    if (options.workspace) {
      conditions.push(eq(Run.workspace, options.workspace));
    }
    if (options.status) {
      conditions.push(eq(Run.status, options.status));
    }

    const query = db.select().from(Run);
    const records = conditions.length > 0
      ? await query.where(and(...conditions)) as RunRecord[]
      : await query as RunRecord[];

    let runs = records.map((record) => this.runRecordToData(record));
    if (options.commandKind) {
      runs = runs.filter((run) => run.commandKind === options.commandKind);
    }

    return runs
      .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
      .slice(0, options.limit ?? runs.length);
  }

  async appendRunStep(event: RunStepRecordData, context: StoreContext): Promise<void> {
    const db = await this.getDb(context);
    if (!db) {
      throw new Error('Cannot access Pod: invalid credentials');
    }

    if (!isRunResourceId(event.runId)) {
      throw new Error(`RunStep runId must be a complete Run resource id: ${event.runId}`);
    }
    event.id = buildRunStepResourceId(event);
    const runResource = event.run || this.resolveDataResource(event.runId, context);

    await db.insert(RunStep).values({
      id: event.id,
      stepType: event.type,
      run: runResource,
      message: event.message || null,
      payload: this.jsonObjectOrNull(event.data),
      createdAt: this.timestampToIso(event.createdAt) ?? new Date().toISOString(),
    });
  }

  async loadRunSteps(runId: string, context: StoreContext): Promise<RunStepRecordData[]> {
    const db = await this.getDb(context);
    if (!db) {
      throw new Error('Cannot access Pod: invalid credentials');
    }

    if (!isRunResourceId(runId)) {
      throw new Error(`loadRunSteps requires a base-relative Run id: ${runId}`);
    }

    const resolvedRun = this.resolveDataResource(runId, context);
    const records = await db.select().from(RunStep).where(eq(RunStep.run, resolvedRun)) as RunStepRecord[];
    return records
      .map((record) => this.runStepRecordToData(record, context))
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  async claimRun(input: {
    runId: string;
    leaseOwner: string;
    leaseExpiresAt: number;
    now: number;
  }, context: StoreContext): Promise<RunRecordData | undefined> {
    const run = await this.loadRun(input.runId, context);
    if (!canClaimRun(run, input)) {
      return undefined;
    }
    run.leaseOwner = input.leaseOwner;
    run.leaseExpiresAt = input.leaseExpiresAt;
    run.heartbeatAt = input.now;
    run.updatedAt = input.now;
    await this.saveRun(run, context);

    const claimed = await this.loadRun(input.runId, context);
    return claimed.leaseOwner === input.leaseOwner ? claimed : undefined;
  }

  // =========================================================================
  // Task Operations
  // =========================================================================

  async saveTask(task: TaskRecordData, context: StoreContext): Promise<void> {
    const db = await this.getDb(context);
    if (!db) {
      throw new Error('Cannot access Pod: invalid credentials');
    }

    task.id = buildTaskResourceId(task.id);
    const existing = await db.findById(Task, task.id) as TaskRecord | null;
    const metadata = this.withXpodMetadata(
      this.withTaskAuthBindingMetadata(task.metadata, task.authBinding),
      {
        surfaceId: task.surfaceId,
        runner: task.runner,
        triggerKind: task.triggerKind,
        cron: task.cron ?? null,
        intervalSeconds: task.intervalSeconds ?? null,
        eventName: task.eventName ?? null,
        nextRunAt: task.nextRunAt ?? null,
        lastRunAt: task.lastRunAt ?? null,
      },
    );
    const values = {
      title: task.title || null,
      instruction: task.prompt,
      prompt: task.prompt,
      workspace: task.workspace,
      status: task.status,
      metadata: this.jsonObjectOrNull(metadata),
      createdAt: this.timestampToIso(task.createdAt) ?? new Date().toISOString(),
      updatedAt: this.timestampToIso(task.updatedAt) ?? new Date().toISOString(),
    };

    if (existing) {
      await db.updateById(Task, task.id, values);
      return;
    }

    await db.insert(Task).values({
      id: task.id,
      ...values,
    });
  }

  async loadTask(taskId: string, context: StoreContext): Promise<TaskRecordData> {
    const db = await this.getDb(context);
    if (!db) {
      throw new Error('Cannot access Pod: invalid credentials');
    }
    const record = await db.findById(Task, taskId) as TaskRecord | null;
    if (!record) {
      throw new Error(`Task not found: ${taskId}`);
    }
    return this.taskRecordToData(record);
  }

  async listTasks(options: TaskListOptions, context: StoreContext): Promise<TaskRecordData[]> {
    const db = await this.getDb(context);
    if (!db) {
      throw new Error('Cannot access Pod: invalid credentials');
    }

    const records = await db.select().from(Task) as TaskRecord[];
    const dueAt = options.dueAt ?? nowTimestamp();
    let tasks = records.map((record) => this.taskRecordToData(record));

    if (options.status) {
      tasks = tasks.filter((task) => task.status === options.status);
    }
    if (options.triggerKind) {
      tasks = tasks.filter((task) => task.triggerKind === options.triggerKind);
    }
    if (options.eventName) {
      tasks = tasks.filter((task) => task.eventName === options.eventName);
    }
    if (typeof options.dueAt === 'number') {
      tasks = tasks.filter((task) => typeof task.nextRunAt === 'number' && task.nextRunAt <= dueAt);
    }

    tasks.sort((a, b) => (a.nextRunAt ?? a.createdAt) - (b.nextRunAt ?? b.createdAt) || a.id.localeCompare(b.id));
    return tasks.slice(0, options.limit ?? tasks.length);
  }

  async saveTaskAuthCredential(input: {
    id: string;
    apiKey: string;
    displayName?: string;
    expiresAt?: number;
  }, context: StoreContext): Promise<{
    id: string;
    service: string;
    status: string;
    apiKey?: string | null;
    label?: string | null;
    oauthExpiresAt?: string | Date | null;
    createdAt?: string | Date | null;
  }> {
    const db = await this.getDb(context);
    if (!db) {
      throw new Error('Cannot access Pod: invalid credentials');
    }

    const values = {
      service: TASK_AUTH_CREDENTIAL_SERVICE,
      status: CredentialStatus.ACTIVE,
      apiKey: input.apiKey,
      label: input.displayName ?? null,
      oauthExpiresAt: this.timestampToIso(input.expiresAt),
    };
    const existing = await db.findById(Credential, input.id);
    if (existing) {
      await db.updateById(Credential, input.id, values);
      return {
        ...existing,
        ...values,
        id: input.id,
      };
    }

    await db.insert(Credential).values({
      id: input.id,
      ...values,
    });
    return {
      id: input.id,
      ...values,
      createdAt: new Date().toISOString(),
    };
  }

  async loadTaskAuthCredential(id: string, context: StoreContext): Promise<{
    id: string;
    service: string;
    status: string;
    apiKey?: string | null;
    label?: string | null;
    oauthExpiresAt?: string | Date | null;
    createdAt?: string | Date | null;
  } | undefined> {
    const db = await this.getDb(context);
    if (!db) {
      throw new Error('Cannot access Pod: invalid credentials');
    }

    const credential = await db.findById(Credential, id);
    if (!credential || credential.service !== TASK_AUTH_CREDENTIAL_SERVICE) {
      return undefined;
    }
    return credential;
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
    const value = provider?.trim();
    if (!value) {
      return '';
    }

    const hashIndex = value.lastIndexOf('#');
    const hashless = hashIndex >= 0 && hashIndex < value.length - 1
      ? value.slice(hashIndex + 1)
      : value;

    const clean = hashless.replace(/\/+$/, '');
    const slashIndex = clean.lastIndexOf('/');
    const tail = slashIndex >= 0 ? clean.slice(slashIndex + 1) : clean;
    const ttlFragmentIndex = tail.lastIndexOf('.ttl#');
    if (ttlFragmentIndex >= 0) {
      return tail.slice(ttlFragmentIndex + '.ttl#'.length);
    }

    if (tail.endsWith('.ttl')) {
      return tail.slice(0, -'.ttl'.length);
    }

    const fragmentIndex = tail.lastIndexOf('#');
    if (fragmentIndex >= 0 && fragmentIndex < tail.length - 1) {
      return tail.slice(fragmentIndex + 1);
    }
    return tail;
  }

  private pushAvailableModel(
    models: any[],
    seenModelIds: Set<string>,
    model: {
      id?: string | null;
      name?: string | null;
      provider?: string | null;
      ownedBy?: string | null;
      contextWindow?: number;
      maxTokens?: number;
    },
  ): void {
    const id = typeof model.id === 'string' ? model.id.trim() : '';
    if (!id || seenModelIds.has(id)) {
      return;
    }

    seenModelIds.add(id);
    const item: Record<string, unknown> = {
      id,
      object: 'model',
    };

    if (typeof model.name === 'string' && model.name.trim()) {
      item.name = model.name.trim();
    }
    if (typeof model.provider === 'string' && model.provider.trim()) {
      item.provider = model.provider.trim();
    }
    if (typeof model.ownedBy === 'string' && model.ownedBy.trim()) {
      item.owned_by = model.ownedBy.trim();
    }
    if (typeof model.contextWindow === 'number' && Number.isFinite(model.contextWindow)) {
      item.context_window = model.contextWindow;
    }
    if (typeof model.maxTokens === 'number' && Number.isFinite(model.maxTokens)) {
      item.max_tokens = model.maxTokens;
    }

    models.push(item);
  }

  private resolvePodResource(context: StoreContext, resource: string): string {
    if (/^https?:\/\//.test(resource)) {
      return resource;
    }
    const podBaseUrl = this.ensurePodBaseUrlCache(context);
    if (!podBaseUrl) {
      throw new Error(`Cannot resolve Pod base URL for resource: ${resource}`);
    }
    return `${podBaseUrl.replace(/\/$/, '')}/${resource.replace(/^\//, '')}`;
  }

  private async findProviderForCredential(db: any, context: StoreContext, providerRef: string): Promise<any | null> {
    const candidates = new Set<string>();
    candidates.add(providerRef);
    if (!/^https?:\/\//.test(providerRef)) {
      candidates.add(this.resolvePodResource(context, providerRef));
    }

    const providerId = normalizeAIConfigProviderId(providerRef);
    if (providerId) {
      candidates.add(providerId);
      candidates.add(`/settings/providers/${providerId}.ttl`);
      candidates.add(this.resolvePodResource(context, `/settings/providers/${providerId}.ttl`));
    }

    for (const candidate of candidates) {
      try {
        const provider = /^https?:\/\//.test(candidate)
          ? await db.findByIri(Provider, candidate)
          : await db.findById(Provider, candidate);
        if (provider) {
          return provider;
        }
      } catch {
        // Try the next canonical form.
      }
    }

    return null;
  }

  private sortAiCredentialCandidates<T extends AiCredentialCandidate>(credentials: T[]): T[] {
    return [...credentials].sort((left, right) => {
      const defaultDelta = Number(this.isTruthyValue(right.isDefault)) - Number(this.isTruthyValue(left.isDefault));
      if (defaultDelta !== 0) {
        return defaultDelta;
      }

      const leftLastUsedAt = this.timestampValue(left.lastUsedAt);
      const rightLastUsedAt = this.timestampValue(right.lastUsedAt);
      if (leftLastUsedAt !== rightLastUsedAt) {
        return leftLastUsedAt - rightLastUsedAt;
      }

      const leftFailCount = typeof left.failCount === 'number' && Number.isFinite(left.failCount) ? left.failCount : 0;
      const rightFailCount = typeof right.failCount === 'number' && Number.isFinite(right.failCount) ? right.failCount : 0;
      if (leftFailCount !== rightFailCount) {
        return leftFailCount - rightFailCount;
      }

      return normalizeAIConfigResourceId(left.id ?? '')
        .localeCompare(normalizeAIConfigResourceId(right.id ?? ''));
    });
  }

  private isTruthyValue(value: unknown): boolean {
    return value === true || value === 'true' || value === 1 || value === '1';
  }

  private timestampValue(value: unknown): number {
    if (value instanceof Date) {
      return value.getTime();
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string' && value.trim()) {
      const timestamp = Date.parse(value);
      return Number.isFinite(timestamp) ? timestamp : 0;
    }
    return 0;
  }

  private parseIntegerValue(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number.parseInt(value, 10);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }

  private extractModelId(model: string | null | undefined): string | undefined {
    if (!model) {
      return undefined;
    }
    const hashIndex = model.lastIndexOf('#');
    if (hashIndex >= 0 && hashIndex < model.length - 1) {
      return model.slice(hashIndex + 1) || undefined;
    }
    const clean = model.replace(/\/+$/, '');
    const slashIndex = clean.lastIndexOf('/');
    const tail = slashIndex >= 0 ? clean.slice(slashIndex + 1) : clean;
    return tail || undefined;
  }

  private async queryAiConfigFromSettingsSparql(context: StoreContext): Promise<AiConfigSelection | null | undefined> {
    const cachedFetch = this.getCachedFetch(context);
    const podBaseUrl = this.ensurePodBaseUrlCache(context);
    if (!cachedFetch || !podBaseUrl) {
      return null;
    }

    const endpoint = `${podBaseUrl.replace(/\/$/, '')}/settings/-/sparql`;
    const query = `
      PREFIX cred: <https://vocab.xpod.dev/credential#>
      PREFIX ai: <https://vocab.xpod.dev/ai#>
      PREFIX udfs: <https://undefineds.co/ns#>
      SELECT ?cred ?provider ?apiKey ?isDefault ?lastUsedAt ?failCount ?providerBaseUrl ?credentialBaseUrl ?providerProxyUrl ?credentialProxyUrl ?defaultModel ?hasModel
      WHERE {
        ?cred (cred:service|udfs:service) "ai" ;
              (cred:status|udfs:status) "active" ;
              (cred:apiKey|udfs:apiKey) ?apiKey .
        OPTIONAL { ?cred (cred:provider|udfs:provider) ?provider . }
        OPTIONAL { ?cred (cred:isDefault|udfs:isDefault) ?isDefault . }
        OPTIONAL { ?cred (cred:lastUsedAt|udfs:lastUsedAt) ?lastUsedAt . }
        OPTIONAL { ?cred (cred:failCount|udfs:failCount) ?failCount . }
        OPTIONAL { ?cred (cred:baseUrl|udfs:baseUrl) ?credentialBaseUrl . }
        OPTIONAL { ?cred (cred:proxyUrl|udfs:proxyUrl) ?credentialProxyUrl . }
        OPTIONAL { ?provider (ai:baseUrl|udfs:baseUrl) ?providerBaseUrl . }
        OPTIONAL { ?provider (ai:proxyUrl|udfs:proxyUrl) ?providerProxyUrl . }
        OPTIONAL { ?provider (ai:defaultModel|udfs:defaultModel) ?defaultModel . }
        OPTIONAL { ?provider (ai:hasModel|udfs:hasModel) ?hasModel . }
      }
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
      throw new Error(`Failed to query settings AI config: ${response.status} ${response.statusText} - ${text}`);
    }

    const json = await response.json() as {
      results?: {
        bindings?: Array<Record<string, { value?: string }>>;
      };
    };

    const credentials = (json.results?.bindings ?? []).map((binding): AiCredentialSparqlCandidate => {
      const credentialIri = this.parseSparqlBindingValue(binding, 'cred') ?? '';
      const providerRef = this.parseSparqlBindingValue(binding, 'provider');
      return {
        id: this.baseRelativeIdFromPodPath(credentialIri, context, '/settings/'),
        provider: providerRef,
        providerId: providerRef ? this.extractProviderId(providerRef) : null,
        apiKey: this.parseSparqlBindingValue(binding, 'apiKey'),
        isDefault: this.parseSparqlBindingValue(binding, 'isDefault'),
        lastUsedAt: this.parseSparqlBindingValue(binding, 'lastUsedAt'),
        failCount: this.parseIntegerValue(this.parseSparqlBindingValue(binding, 'failCount')),
        baseUrl: this.parseSparqlBindingValue(binding, 'providerBaseUrl')
          ?? this.parseSparqlBindingValue(binding, 'credentialBaseUrl'),
        proxyUrl: this.parseSparqlBindingValue(binding, 'providerProxyUrl')
          ?? this.parseSparqlBindingValue(binding, 'credentialProxyUrl'),
        defaultModel: this.parseSparqlBindingValue(binding, 'defaultModel')
          ?? this.parseSparqlBindingValue(binding, 'hasModel'),
      };
    });

    for (const cred of this.sortAiCredentialCandidates(credentials)) {
      if (!cred.provider || !cred.apiKey || !cred.baseUrl) {
        continue;
      }

      const providerId = cred.providerId || this.extractProviderId(cred.provider);
      if (!providerId) {
        continue;
      }

      this.logger.debug(`Using credential ${cred.id} with provider ${providerId}`);
      return {
        providerId,
        baseUrl: cred.baseUrl,
        proxyUrl: cred.proxyUrl || undefined,
        defaultModel: this.extractModelId(cred.defaultModel),
        apiKey: cred.apiKey,
        credentialId: cred.id!,
      };
    }

    return undefined;
  }

  async getAiConfig(context: StoreContext): Promise<{
    providerId: string;
    baseUrl: string;
    proxyUrl?: string;
    defaultModel?: string;
    apiKey: string;
    credentialId: string;
  } | undefined> {
    const db = await this.getDb(context);
    if (!db) {
      return undefined;
    }
    this.ensurePodBaseUrlCache(context, db);

    try {
      try {
        const sparqlConfig = await this.queryAiConfigFromSettingsSparql(context);
        if (sparqlConfig !== null) {
          return sparqlConfig ?? undefined;
        }
      } catch (error) {
        this.logger.warn(`Failed to read AI config via settings SPARQL, falling back to model tables: ${error}`);
      }

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

      // Select deterministically; RDF document serialization order is not config semantics.
      for (const cred of this.sortAiCredentialCandidates(credentials)) {
        if (!cred.provider) continue;

        const provider = await this.findProviderForCredential(db, context, cred.provider);
        if (!provider) continue;

        const baseUrl = provider.baseUrl;
        if (!baseUrl) continue;

        const defaultModelRef = provider.defaultModel ?? provider.hasModel;
        const defaultModel = defaultModelRef
          ? (await db.findByIri(Model, defaultModelRef))?.id ?? undefined
          : undefined;

        const providerId = this.extractProviderId(provider.id || cred.provider);
        this.logger.debug(`Using credential ${cred.id} with provider ${providerId}`);

        return {
          providerId,
          baseUrl,
          proxyUrl: provider.proxyUrl || undefined,
          defaultModel,
          apiKey: cred.apiKey!,
          credentialId: cred.id!,
        };
      }

      return undefined;
    } catch (error) {
      this.logger.warn(`Failed to read AI config from Pod: ${error}`);
      return undefined;
    }
  }

  async listAvailableModels(context: StoreContext): Promise<any[]> {
    const db = await this.getDb(context);
    if (!db) {
      return [];
    }

    const config = await this.getAiConfig(context);
    if (!config) {
      return [];
    }

    const models: any[] = [];
    const seenModelIds = new Set<string>();
    const providerByKey = new Map<string, any>();
    let providerDisplayName = config.providerId;

    try {
      const providers = await db.select().from(Provider) as any[];
      for (const provider of providers) {
        const uri = typeof provider?.['@id'] === 'string' ? provider['@id'] : undefined;
        if (uri) {
          providerByKey.set(uri, provider);
        }
        if (typeof provider?.id === 'string' && provider.id) {
          providerByKey.set(provider.id, provider);
          providerByKey.set(this.extractProviderId(provider.id), provider);
        }
      }

      const currentProvider = providerByKey.get(config.providerId)
        ?? providers.find((provider: any) => provider?.baseUrl === config.baseUrl);
      if (typeof currentProvider?.displayName === 'string' && currentProvider.displayName.trim()) {
        providerDisplayName = currentProvider.displayName.trim();
      }
    } catch (error) {
      this.logger.warn(`Failed to load providers for model listing: ${error}`);
    }

    try {
      const podModels = await db.select().from(Model) as any[];
      for (const model of podModels) {
        const providerRef = typeof model?.isProvidedBy === 'string' ? model.isProvidedBy : '';
        const modelProvider = providerByKey.get(providerRef)
          ?? providerByKey.get(this.extractProviderId(providerRef));
        const modelProviderId = typeof modelProvider?.id === 'string' && modelProvider.id
          ? modelProvider.id
          : this.extractProviderId(providerRef);

        if (modelProviderId && modelProviderId !== config.providerId && model.id !== config.defaultModel) {
          continue;
        }

        this.pushAvailableModel(models, seenModelIds, {
          id: model.id,
          name: model.displayName || model.id,
          provider: modelProviderId || config.providerId,
          ownedBy: modelProvider?.displayName || providerDisplayName,
          contextWindow: typeof model.contextLength === 'number' ? model.contextLength : undefined,
          maxTokens: typeof model.maxOutputTokens === 'number' ? model.maxOutputTokens : undefined,
        });
      }
    } catch (error) {
      this.logger.warn(`Failed to load Pod models for ${config.providerId}: ${error}`);
    }

    if (models.length === 0 && config.defaultModel) {
      this.pushAvailableModel(models, seenModelIds, {
        id: config.defaultModel,
        name: config.defaultModel,
        provider: config.providerId,
        ownedBy: providerDisplayName,
      });
    }

    return models;
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
        const currentCred = await db.findById(Credential, credentialId);
        if (currentCred) {
          updateData.failCount = (currentCred.failCount ?? 0) + 1;
        }
      }

      await db.updateById(Credential, credentialId, updateData);

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
      await db.updateById(Credential, credentialId, {
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
