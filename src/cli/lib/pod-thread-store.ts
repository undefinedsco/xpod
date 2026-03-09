/**
 * Conversation thread storage backed by the user's Solid Pod.
 *
 * Uses drizzle-solid to operate on Chat + Thread + Message tables,
 * following the same protocol as API/ChatKit.
 *
 * Data model:
 * - Chat = 通讯录（跟谁聊）：由 participants 决定，不再由 cwd hash 生成
 * - Thread = 对话实例（聊什么、在哪聊）：workspace 是一级字段
 */

import { drizzle, eq } from '@undefineds.co/drizzle-solid';
import { Chat, Thread, Message } from '../../api/chatkit/schema';
import type { Session } from '@inrupt/solid-client-authn-node';

/** Default Chat ID for CLI 1v1 conversations with SecretaryAI */
const DEFAULT_CLI_CHAT_ID = 'cli-default';

export interface ThreadMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
}

export interface ThreadData {
  id: string;
  title?: string;
  workspace?: string;
  createdAt: string;
  updatedAt: string;
  messages: ThreadMessage[];
}

/**
 * Create a drizzle-solid database instance from an authenticated Session.
 */
function createDb(session: Session) {
  return drizzle({
    fetch: session.fetch,
    info: session.info,
  } as any);
}

/**
 * Get or create the default 1v1 Chat for CLI (user ↔ SecretaryAI).
 * Returns the chatId (bare ID, not URI).
 */
export async function getOrCreateDefaultChat(session: Session): Promise<string> {
  const chatId = DEFAULT_CLI_CHAT_ID;
  try {
    const db = createDb(session);
    await ensureChat(db, chatId, session.info.webId!);
  } catch (error) {
    console.error('Failed to ensure default chat:', error);
  }
  return chatId;
}

/**
 * List thread IDs (most-recent first) for a given chatId.
 * Uses direct SPARQL because eq() on optional uri() fields still has issues.
 */
export async function listThreads(session: Session, chatId: string): Promise<string[]> {
  try {
    const podBaseUrl = session.info.webId!.replace('/profile/card#me', '');
    const endpoint = `${podBaseUrl}/.data/chat/-/sparql`;
    const chatSubject = `<${podBaseUrl}/.data/chat/${chatId}/index.ttl#this>`;

    // Note: Removed OPTIONAL to avoid filtering out threads without createdAt
    // OPTIONAL in GRAPH ?g context can cause incomplete results (40 vs 57 threads)
    const query = `
      PREFIX sioc: <http://rdfs.org/sioc/ns#>
      PREFIX udfs: <https://undefineds.co/ns#>
      SELECT ?thread ?createdAt
      WHERE {
        ?thread a sioc:Thread ;
                sioc:has_parent ${chatSubject} ;
                udfs:createdAt ?createdAt .
      }
      ORDER BY DESC(?createdAt)
    `;

    const res = await session.fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/sparql-query',
        'Accept': 'application/sparql-results+json',
      },
      body: query,
    });

    if (!res.ok) return [];

    const json = await res.json();
    const bindings = json.results?.bindings || [];

    // Extract thread ID from URI fragment: ...index.ttl#thread-xxx → thread-xxx
    return bindings
      .map((b: any) => {
        const uri = b.thread?.value || '';
        const hash = uri.lastIndexOf('#');
        return hash >= 0 ? uri.slice(hash + 1) : '';
      })
      .filter((id: string) => id.length > 0);
  } catch (error) {
    console.error('Failed to list threads:', error);
    return [];
  }
}

/**
 * Load a thread by ID with all its messages.
 */
export async function loadThread(
  session: Session,
  chatId: string,
  threadId: string,
): Promise<ThreadData | null> {
  try {
    const db = createDb(session);
    const podBaseUrl = session.info.webId!.replace('/profile/card#me', '');
    const threadUri = `${podBaseUrl}/.data/chat/${chatId}/index.ttl#${threadId}`;

    // Query thread by full URI
    const thread = await db.findByIri(Thread, threadUri);
    if (!thread) return null;

    // Query messages using direct SPARQL
    // Note: OPTIONAL works correctly with date-grouped files (messages.ttl)
    const endpoint = `${podBaseUrl}/.data/chat/-/sparql`;
    const threadSubject = `<${threadUri}>`;

    const messagesQuery = `
      PREFIX meeting: <http://www.w3.org/ns/pim/meeting#>
      PREFIX sioc: <http://rdfs.org/sioc/ns#>
      PREFIX udfs: <https://undefineds.co/ns#>
      SELECT ?role ?content ?createdAt
      WHERE {
        ?msg a meeting:Message ;
             sioc:has_container ${threadSubject} .
        OPTIONAL { ?msg udfs:role ?role . }
        OPTIONAL { ?msg sioc:content ?content . }
        OPTIONAL { ?msg udfs:createdAt ?createdAt . }
      }
      ORDER BY ?createdAt
    `;

    const messagesRes = await session.fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/sparql-query',
        'Accept': 'application/sparql-results+json',
      },
      body: messagesQuery,
    });

    const messagesJson = messagesRes.ok ? await messagesRes.json() : { results: { bindings: [] } };
    const messageBindings = messagesJson.results?.bindings || [];

    // Extract bare ID from thread.id
    const bareId = typeof thread.id === 'string' && thread.id.includes('#')
      ? thread.id.split('#').pop() || threadId
      : thread.id;

    return {
      id: bareId,
      title: thread.title || undefined,
      workspace: thread.workspace || undefined,
      createdAt: thread.createdAt?.toISOString() || new Date().toISOString(),
      updatedAt: thread.updatedAt?.toISOString() || new Date().toISOString(),
      messages: messageBindings.map((m: any) => ({
        role: m.role?.value || 'user',
        content: m.content?.value || '',
        timestamp: m.createdAt?.value || new Date().toISOString(),
      })),
    };
  } catch (error) {
    console.error('Failed to load thread:', error);
    return null;
  }
}

/**
 * Save a message to a thread.
 */
export async function saveMessage(
  session: Session,
  chatId: string,
  threadId: string,
  message: ThreadMessage,
): Promise<boolean> {
  try {
    const db = createDb(session);

    // Ensure chat exists
    await ensureChat(db, chatId, session.info.webId!);

    // Ensure thread exists
    await ensureThread(db, chatId, threadId, session.info.webId!);

    // 构建完整的 Thread URI（用于 RDF 引用）
    const podBaseUrl = session.info.webId!.replace('/profile/card#me', '');
    const threadUri = `${podBaseUrl}/.data/chat/${chatId}/index.ttl#${threadId}`;

    // Insert message
    // Note: yyyy/MM/dd are automatically extracted from createdAt by drizzle-solid
    const messageId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await db.insert(Message).values({
      id: messageId,
      chatId,
      threadId: threadUri,  // 传入完整 URI
      maker: session.info.webId!,
      role: message.role,
      content: message.content,
      status: 'completed',
      createdAt: new Date(message.timestamp),
    });

    return true;
  } catch (error) {
    console.error('Failed to save message:', error);
    return false;
  }
}

/**
 * Save a tool call as a message with metadata.
 */
export async function saveToolCall(
  session: Session,
  chatId: string,
  threadId: string,
  toolCall: {
    toolName: string;
    toolCallId: string;
    arguments: any;
    output?: string;
    status: 'pending' | 'completed' | 'failed';
  },
): Promise<boolean> {
  try {
    const db = createDb(session);

    // Ensure chat and thread exist
    await ensureChat(db, chatId, session.info.webId!);
    await ensureThread(db, chatId, threadId, session.info.webId!);

    // 构建完整的 Thread URI（用于 RDF 引用）
    const podBaseUrl = session.info.webId!.replace('/profile/card#me', '');
    const threadUri = `${podBaseUrl}/.data/chat/${chatId}/index.ttl#${threadId}`;

    // Insert tool call message
    // Note: yyyy/MM/dd are automatically extracted from createdAt by drizzle-solid
    const messageId = `tool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await db.insert(Message).values({
      id: messageId,
      chatId,
      threadId: threadUri,  // 传入完整 URI
      maker: session.info.webId!,
      role: 'tool_call',
      content: `Executed ${toolCall.toolName}`,
      status: toolCall.status,
      toolName: toolCall.toolName,
      toolCallId: toolCall.toolCallId,
      metadata: JSON.stringify({
        type: 'tool_call',
        toolName: toolCall.toolName,
        toolCallId: toolCall.toolCallId,
        arguments: toolCall.arguments,
        output: toolCall.output,
        status: toolCall.status,
      }),
      createdAt: new Date(),
    });

    return true;
  } catch (error) {
    console.error('Failed to save tool call:', error);
    return false;
  }
}

/**
 * Create a fresh thread.
 * workspace is stored as a first-class field on Thread.
 */
export async function createThread(
  session: Session,
  chatId: string,
  workspace?: string,
  title?: string,
): Promise<string> {
  const threadId = `thread-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  try {
    const db = createDb(session);

    // Ensure chat exists
    await ensureChat(db, chatId, session.info.webId!);

    // Create thread with workspace as first-class field
    const now = new Date();
    await db.insert(Thread).values({
      id: threadId,
      chatId,
      title: title || 'CLI Conversation',
      workspace: workspace || null,
      status: 'active',
      metadata: JSON.stringify({ source: 'cli' }),
      createdAt: now,
      updatedAt: now,
    });

    return threadId;
  } catch (error) {
    console.error('Failed to create thread:', error);
    return threadId; // Return ID anyway, will be created on first message
  }
}

// ============================================================================
// Internal Helpers
// ============================================================================

async function ensureChat(db: any, chatId: string, webId: string): Promise<void> {
  try {
    // Use findByIri to avoid OPTIONAL bug in SPARQL queries
    const podBaseUrl = webId.replace('/profile/card#me', '');
    const chatUri = `${podBaseUrl}/.data/chat/${chatId}/index.ttl#this`;
    const chat = await db.findByIri(Chat, chatUri);

    if (!chat) {
      const now = new Date();
      await db.insert(Chat).values({
        id: chatId,
        title: 'CLI Chat',
        author: webId,
        participants: [],
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
    }
  } catch (error) {
    // Ignore if already exists
  }
}

async function ensureThread(db: any, chatId: string, threadId: string, webId: string): Promise<void> {
  try {
    // Use findByIri to avoid OPTIONAL bug in SPARQL queries
    const podBaseUrl = webId.replace('/profile/card#me', '');
    const threadUri = `${podBaseUrl}/.data/chat/${chatId}/index.ttl#${threadId}`;
    const thread = await db.findByIri(Thread, threadUri);

    if (!thread) {
      const now = new Date();
      await db.insert(Thread).values({
        id: threadId,
        chatId,
        title: 'CLI Conversation',
        status: 'active',
        metadata: JSON.stringify({ source: 'cli' }),
        createdAt: now,
        updatedAt: now,
      });
    }
  } catch (error) {
    // Ignore if already exists
  }
}
