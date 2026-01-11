/**
 * ChatKit Pod Schema - SolidOS Long Chat 兼容
 *
 * 使用 SolidOS 标准的 chat 数据模型:
 * - Thread = meeting:LongChat
 * - Message = sioc:content + dct:created + dc:author
 *
 * 存储结构:
 * /chat/
 *   {thread-id}/
 *     index.ttl      # Thread 元数据 + 消息
 *     {YYYY-MM-DD}.ttl  # 按日期分片的消息（可选）
 *
 * RDF 示例:
 * ```turtle
 * @prefix meeting: <http://www.w3.org/ns/pim/meeting#> .
 * @prefix sioc: <http://rdfs.org/sioc/ns#> .
 * @prefix dc: <http://purl.org/dc/terms/> .
 * @prefix wf: <http://www.w3.org/2005/01/wf/flow#> .
 * @prefix udfs: <https://undefineds.co/ns#> .
 *
 * <#this> a meeting:LongChat ;
 *     dc:title "Chat Title" ;
 *     dc:created "2026-01-11T10:00:00Z"^^xsd:dateTime ;
 *     dc:author <webid> ;
 *     udfs:threadStatus "active" ;
 *     wf:message <#msg-1>, <#msg-2> .
 *
 * <#msg-1> sioc:content "Hello" ;
 *     dc:created "2026-01-11T10:00:00Z"^^xsd:dateTime ;
 *     dc:author <webid> ;
 *     udfs:role "user" .
 *
 * <#msg-2> sioc:content "Hi there!" ;
 *     dc:created "2026-01-11T10:00:01Z"^^xsd:dateTime ;
 *     udfs:role "assistant" ;
 *     udfs:messageStatus "completed" .
 * ```
 */

import { podTable, string, datetime, uri } from 'drizzle-solid';
import { Meeting, SIOC } from '../../vocab';
import { UDFS_NAMESPACE } from '../../vocab';

// ============================================================================
// Thread Schema (meeting:LongChat)
// ============================================================================

/**
 * ChatThread - 对话 Thread
 *
 * 对应 SolidOS 的 meeting:LongChat
 * 存储位置: /chat/{thread-id}/index.ttl#this
 */
export const ChatThread = podTable(
  'ChatThread',
  {
    id: string('id').primaryKey(),
    title: string('title'),
    author: uri('author'),          // dc:author -> WebID
    status: string('status'),       // udfs:threadStatus: active/locked/closed
    createdAt: datetime('createdAt'),
    updatedAt: datetime('updatedAt'),
  },
  {
    base: '/chat/',
    type: Meeting.LongChat,
    namespace: UDFS_NAMESPACE,
    subjectTemplate: '{id}/index.ttl#this',
  },
);

// ============================================================================
// Message Schema (sioc-based)
// ============================================================================

/**
 * ChatMessage - 对话消息
 *
 * 使用 SIOC 词汇:
 * - sioc:content 存储消息内容
 * - dc:created 存储创建时间
 * - dc:author 存储作者 (user message)
 * - udfs:role 存储角色 (user/assistant/system)
 *
 * 存储位置: /chat/{thread-id}/index.ttl#{msg-id}
 */
export const ChatMessage = podTable(
  'ChatMessage',
  {
    id: string('id').primaryKey(),
    threadId: string('threadId'),   // 所属 thread
    content: string('content'),     // sioc:content
    role: string('role'),           // udfs:role: user/assistant/system
    author: uri('author'),          // dc:author (for user messages)
    status: string('status'),       // udfs:messageStatus: in_progress/completed/incomplete
    createdAt: datetime('createdAt'),
  },
  {
    base: '/chat/',
    type: SIOC.Post,  // SIOC Post for messages
    namespace: UDFS_NAMESPACE,
    // Message stored in same file as thread: /chat/{threadId}/index.ttl#{id}
    subjectTemplate: '{threadId}/index.ttl#{id}',
  },
);

// ============================================================================
// Helper Types
// ============================================================================

export type ChatThreadRecord = typeof ChatThread.$inferSelect;
export type ChatMessageRecord = typeof ChatMessage.$inferSelect;

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

// ============================================================================
// Path Helpers
// ============================================================================

/**
 * 获取 Thread 的存储路径
 */
export function getThreadPath(threadId: string): string {
  return `/chat/${threadId}/index.ttl`;
}

/**
 * 获取 Thread 的 subject URI fragment
 */
export function getThreadSubject(threadId: string): string {
  return `#this`;
}

/**
 * 获取 Message 的 subject URI fragment
 */
export function getMessageSubject(messageId: string): string {
  return `#${messageId}`;
}
