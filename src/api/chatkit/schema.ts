/**
 * ChatKit Pod Schema
 *
 * 数据模型对齐:
 * - Chat (meeting:LongChat) - 对话容器（微信中间栏）
 * - Thread (sioc:Thread) - ChatKit thread，作为 Chat 的 fragment
 * - Message (meeting:Message) - ChatKit item，放在 Chat 下
 *
 * 存储结构:
 * /.data/chat/{chatId}/
 *   index.ttl
 *     #this                           # Chat 元数据
 *     #{threadId}                     # Thread (fragment, ChatKit thread)
 *   {yyyy}/{MM}/{dd}/messages.ttl
 *     #{msgId}                        # Message (ChatKit item)
 *
 * 映射关系:
 * - 微信中间栏 Chat 列表 → Chat
 * - ChatKit Thread → Thread (Chat 的 fragment)
 * - ChatKit ThreadItem → Message
 *
 * 注意：Agent 配置（model, systemPrompt）不在 Chat 中，应该在单独的 Agent 表中
 *
 * RDF 示例:
 * ```turtle
 * # /.data/chat/workspace-1/index.ttl
 * @prefix meeting: <http://www.w3.org/ns/pim/meeting#> .
 * @prefix sioc: <http://rdfs.org/sioc/ns#> .
 * @prefix dc: <http://purl.org/dc/terms/> .
 * @prefix foaf: <http://xmlns.com/foaf/0.1/> .
 * @prefix udfs: <https://undefineds.co/ns#> .
 *
 * <#this> a meeting:LongChat ;
 *     dc:title "工作区" ;
 *     dc:author <https://user.pod/profile/card#me> ;
 *     udfs:status "active" .
 *
 * <#thread-1> a sioc:Thread ;
 *     sioc:has_parent <#this> ;
 *     dc:title "关于代码重构的讨论" ;
 *     udfs:status "active" ;
 *     dc:created "2024-01-15T10:00:00Z"^^xsd:dateTime .
 *
 * # /.data/chat/workspace-1/2024/01/15/messages.ttl
 * <#msg-1> a meeting:Message ;
 *     sioc:has_container <../../../index.ttl#thread-1> ;
 *     foaf:maker <https://user.pod/profile/card#me> ;
 *     udfs:role "user" ;
 *     sioc:content "Hello" ;
 *     dc:created "2024-01-15T10:00:00Z"^^xsd:dateTime .
 *
 * <#msg-2> a meeting:Message ;
 *     sioc:has_container <../../../index.ttl#thread-1> ;
 *     foaf:maker </.data/agents/claude.ttl#this> ;
 *     udfs:role "assistant" ;
 *     sioc:content "Hi there!" ;
 *     udfs:status "completed" ;
 *     dc:created "2024-01-15T10:00:01Z"^^xsd:dateTime .
 * ```
 */

import { podTable, string, datetime, uri } from 'drizzle-solid';
import { Meeting, SIOC, FOAF } from '../../vocab';
import { UDFS_NAMESPACE } from '../../vocab';

// ============================================================================
// Chat Schema (meeting:LongChat) - 对话容器
// ============================================================================

/**
 * Chat - 对话容器
 *
 * 对应微信中间栏的 Chat 列表，可以是群聊或私聊
 *
 * 注意：Agent 配置（model, systemPrompt）不在这里，应该在单独的 Agent 表中
 *
 * 存储位置: /.data/chat/{chatId}/index.ttl#this
 */
export const Chat = podTable(
  'Chat',
  {
    id: string('id').primaryKey(),
    title: string('title'),
    author: uri('author'),
    participants: uri('participants').array(),
    status: string('status'),
    createdAt: datetime('createdAt'),
    updatedAt: datetime('updatedAt'),
  },
  {
    base: '/.data/chat/',
    type: Meeting.LongChat,
    namespace: UDFS_NAMESPACE,
    subjectTemplate: '{id}/index.ttl#this',
    sparqlEndpoint: '/.data/chat/-/sparql',
  },
);

// ============================================================================
// Thread Schema (sioc:Thread) - ChatKit thread
// ============================================================================

/**
 * Thread - ChatKit 的 thread（对话线程）
 *
 * 作为 Chat 的 fragment，与 Chat 元数据存储在同一文件。
 * 对应 ChatKit 的 Thread 概念，是一次完整的对话。
 *
 * 存储位置: /.data/chat/{chatId}/index.ttl#{id}
 */
export const Thread = podTable(
  'Thread',
  {
    id: string('id').primaryKey(),
    chatId: uri('chatId').predicate(SIOC.has_parent).reference(Chat),
    title: string('title'),
    status: string('status'),
    /**
     * JSON string for extended metadata (e.g., xpod runtime hints).
     * Note: drizzle-solid stores this as an RDF literal.
     */
    metadata: string('metadata'),
    createdAt: datetime('createdAt'),
    updatedAt: datetime('updatedAt'),
  },
  {
    base: '/.data/chat/',
    type: SIOC.Thread,
    namespace: UDFS_NAMESPACE,
    subjectTemplate: '{chatId}/index.ttl#{id}',
    sparqlEndpoint: '/.data/chat/-/sparql',
  },
);

// ============================================================================
// Message Schema (meeting:Message) - ChatKit item
// ============================================================================

/**
 * Message - ChatKit 的 ThreadItem（单条消息）
 *
 * 放在 Chat 下，通过 threadId 关联到 Thread。
 * 对应 ChatKit 的 ThreadItem 概念。
 *
 * 存储位置: /.data/chat/{chatId}/{id}.ttl#{id}
 */
export const Message = podTable(
  'Message',
  {
    id: string('id').primaryKey(),
    // chatId 用于路径构建
    chatId: string('chatId'),
    // threadId 关联到 Thread (ChatKit thread) - 使用简单字符串便于查询
    threadId: string('threadId'),
    maker: uri('maker').predicate(FOAF.maker),
    role: string('role'),
    content: string('content').predicate(SIOC.content),
    status: string('status'),
    createdAt: datetime('createdAt'),
  },
  {
    base: '/.data/chat/',
    type: Meeting.Message,
    namespace: UDFS_NAMESPACE,
    subjectTemplate: '{chatId}/{id}.ttl#{id}',
    sparqlEndpoint: '/.data/chat/-/sparql',
  },
);

// ============================================================================
// Types
// ============================================================================

export type ChatRecord = typeof Chat.$inferSelect;
export type ThreadRecord = typeof Thread.$inferSelect;
export type MessageRecord = typeof Message.$inferSelect;

export const ChatStatus = {
  ACTIVE: 'active',
  ARCHIVED: 'archived',
  DELETED: 'deleted',
} as const;

export type ChatStatusType = (typeof ChatStatus)[keyof typeof ChatStatus];

export const ThreadStatus = {
  ACTIVE: 'active',
  LOCKED: 'locked',
  CLOSED: 'closed',
} as const;

export type ThreadStatusType = (typeof ThreadStatus)[keyof typeof ThreadStatus];

export const MessageRole = {
  USER: 'user',
  ASSISTANT: 'assistant',
  SYSTEM: 'system',
} as const;

export type MessageRoleType = (typeof MessageRole)[keyof typeof MessageRole];

export const MessageStatus = {
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
  INCOMPLETE: 'incomplete',
} as const;

export type MessageStatusType = (typeof MessageStatus)[keyof typeof MessageStatus];
