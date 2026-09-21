import type { ServerResponse } from 'node:http';
import { getLoggerFor } from 'global-logger-factory';
import type { AuthenticatedRequest } from '../middleware/AuthMiddleware';
import type { ApiServer } from '../ApiServer';
import type { AuthContext } from '../auth/AuthContext';
import { getWebId, getAccountId, getDisplayName } from '../auth/AuthContext';
import type { ChatKitStore, StoreContext } from '../chatkit/store';
import {
  getThreadParent,
  nowTimestamp,
  toThreadRef,
  type AssistantMessageItem,
  type ClientToolCallItem,
  type ThreadMetadata,
  type ThreadRef,
  type UserMessageItem,
} from '../chatkit/types';

const XPOD_THREAD_ID_HEADER = 'X-Xpod-Thread-Id';

/**
 * Chat completion request (OpenAI-compatible)
 */
export interface ChatCompletionRequest {
  model: string;
  messages: Array<Record<string, unknown> & {
    role: string;
    content?: unknown;
  }>;
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  tools?: unknown[];
  tool_choice?: unknown;
  [key: string]: unknown;
}

/**
 * Chat completion response (OpenAI-compatible)
 */
export interface ChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: 'assistant';
      content: string | null;
      tool_calls?: unknown[];
    };
    finish_reason: 'stop' | 'length' | 'content_filter' | 'tool_calls' | null;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface ChatHandlerOptions {
  /**
   * Backend chat service to delegate to (e.g., OpenAI, local model)
   */
  chatService?: {
    complete(request: ChatCompletionRequest, auth: AuthContext): Promise<ChatCompletionResponse>;
    stream(request: ChatCompletionRequest, auth: AuthContext): Promise<any>;
    responses?(body: any, auth: AuthContext): Promise<any>;
    messages?(body: any, auth: AuthContext): Promise<any>;
    listModels(auth?: AuthContext): Promise<any[]>;
  };
  /** Store used to persist OpenAI-compatible chat sessions in the caller's Pod. */
  chatStore?: ChatKitStore<StoreContext>;
  /**
   * Pod base URL for storage
   */
  podBaseUrl?: string;
}

/**
 * Handler for chat completions API (OpenAI-compatible)
 * 
 * POST /v1/chat/completions - Create a chat completion
 * POST /v1/responses - Create a response (OpenAI Responses API)
 * POST /v1/messages - Create a message (Anthropic/OpenAI Threads compatible)
 * GET  /v1/models - List available models
 * 
 * Supports both Solid Token (frontend) and CSS client credentials (third-party)
 */
export function registerChatRoutes(server: ApiServer, options: ChatHandlerOptions): void {
  const logger = getLoggerFor('ChatHandler');
  const chatService = options.chatService;
  const chatStore = options.chatStore;

  // POST /api/chat/completions
  server.post('/v1/chat/completions', async (request, response, _params) => {
    const auth = request.auth!;
    const body = await readJsonBody(request);

    if (!body || typeof body !== 'object') {
      sendJson(response, 400, {
        error: {
          message: 'Request body must be a JSON object',
          type: 'invalid_request_error',
          code: 'invalid_body',
        },
      });
      return;
    }

    const payload = body as Record<string, unknown>;

    // Validate required fields
    if (!payload.model || typeof payload.model !== 'string') {
      sendJson(response, 400, {
        error: {
          message: 'model is required',
          type: 'invalid_request_error',
          code: 'missing_model',
        },
      });
      return;
    }

    if (!Array.isArray(payload.messages) || payload.messages.length === 0) {
      sendJson(response, 400, {
        error: {
          message: 'messages array is required and must not be empty',
          type: 'invalid_request_error',
          code: 'missing_messages',
        },
      });
      return;
    }

    // Get user identifier for rate limiting / logging
    const userId = getWebId(auth) ?? getAccountId(auth) ?? 'anonymous';
    const displayName = getDisplayName(auth) || userId;
    const accountId = getAccountId(auth);


    // Check if service is available
    if (!chatService) {
      sendJson(response, 503, {
        error: {
          message: 'Chat service is not configured',
          type: 'service_unavailable',
          code: 'service_not_configured',
        },
      });
      return;
    }

    try {
      const messages = payload.messages as ChatCompletionRequest['messages'];
      const completionRequest: ChatCompletionRequest = {
        ...payload,
        model: payload.model as string,
        messages,
      };
      const requestedThreadId = readHeader(request, XPOD_THREAD_ID_HEADER);
      const session = chatStore
        ? await beginChatCompletionSession(chatStore, completionRequest, auth, requestedThreadId)
        : undefined;
      if (session) {
        response.setHeader(XPOD_THREAD_ID_HEADER, session.thread.id);
      }

      // Handle streaming
      if (completionRequest.stream === true) {
        const streamResult = await chatService.stream(completionRequest, auth);
        // Vercel AI SDK v6 uses toTextStreamResponse (not toDataStreamResponse)
        const providerResponse = streamResult.toTextStreamResponse();
        const webResponse = session
          ? wrapCompletionStream(providerResponse, async (text) => {
            try {
              await persistAssistantMessages(chatStore!, session, [{
                index: 0,
                message: { role: 'assistant', content: text },
                finish_reason: 'stop',
              }]);
            } catch (error) {
              logger.error(`Failed to persist streamed chat completion: ${error}`);
            }
          })
          : providerResponse;

        // Copy headers (Content-Type: text/plain; charset=utf-8, X-Vercel-AI-Data-Stream: v1)
        webResponse.headers.forEach((value: string, key: string) => {
          response.setHeader(key, value);
        });
        response.statusCode = webResponse.status;

        // Pipe Web Stream to Node Response
        if (webResponse.body) {
          const reader = webResponse.body.getReader();
          const pump = async () => {
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) {
                  break;
                }
                response.write(value);
              }
            } catch (e) {
              logger.error(`Stream write error: ${e}`);
            } finally {
              response.end();
            }
          };
          pump();
        } else {
          response.end();
        }
        return;
      }

      logger.info(`Chat completion request from ${displayName} (acc: ${accountId}), model: ${completionRequest.model}`);

      const result = await chatService.complete(completionRequest, auth);
      if (session) {
        await persistAssistantMessages(chatStore!, session, result.choices);
      }
      sendJson(response, 200, result);
    } catch (error: any) {
      if (error?.code === 'model_not_configured') {
        sendJson(response, 400, {
          error: {
            message: error.message || 'Model is not configured',
            type: 'invalid_request_error',
            code: 'model_not_configured',
          },
        });
        return;
      }
      logger.error(`Chat completion error: ${error}`);
      sendJson(response, 500, {
        error: {
          message: error.message || 'Internal server error',
          stack: error.stack,
          type: 'internal_error',
          code: 'internal_error',
        },
      });
    }
  });

  // POST /v1/responses - Create a response
  server.post('/v1/responses', async (request, response, _params) => {
    const auth = request.auth!;
    const body = await readJsonBody(request);
    const userId = getWebId(auth) ?? getAccountId(auth) ?? 'anonymous';
    const displayName = getDisplayName(auth) || userId;
    const accountId = getAccountId(auth);

    if (!chatService || !chatService.responses) {
      sendJson(response, 501, { error: 'Responses API not implemented or configured' });
      return;
    }

    try {
      const sessionRequest = responseBodyToCompletionRequest(body);
      const requestedThreadId = readHeader(request, XPOD_THREAD_ID_HEADER);
      const session = chatStore && sessionRequest
        ? await beginChatCompletionSession(chatStore, sessionRequest, auth, requestedThreadId, 'openai.responses')
        : undefined;
      if (session) {
        response.setHeader(XPOD_THREAD_ID_HEADER, session.thread.id);
      }

      logger.info(`Responses API request from ${displayName} (acc: ${accountId})`);
      const result = await chatService.responses(body, auth);
      if (session) {
        await persistResponsesResult(chatStore!, session, result);
      }
      sendJson(response, 200, result);
    } catch (error: any) {
      logger.error(`Responses API error: ${error}`);
      sendJson(response, 500, { error: error.message || 'Internal server error' });
    }
  });

  // POST /v1/messages - Create a message
  server.post('/v1/messages', async (request, response, _params) => {
    const auth = request.auth!;
    const body = await readJsonBody(request);
    const userId = getWebId(auth) ?? getAccountId(auth) ?? 'anonymous';
    const displayName = getDisplayName(auth) || userId;
    const accountId = getAccountId(auth);

    if (!chatService || !chatService.messages) {
      sendJson(response, 501, { error: 'Messages API not implemented or configured' });
      return;
    }

    try {
      const sessionRequest = messagesBodyToCompletionRequest(body);
      const requestedThreadId = readHeader(request, XPOD_THREAD_ID_HEADER);
      const session = chatStore && sessionRequest
        ? await beginChatCompletionSession(chatStore, sessionRequest, auth, requestedThreadId, 'anthropic.messages')
        : undefined;
      if (session) {
        response.setHeader(XPOD_THREAD_ID_HEADER, session.thread.id);
      }

      logger.info(`Messages API request from ${displayName} (acc: ${accountId})`);
      const result = await chatService.messages(body, auth);
      if (session) {
        await persistMessagesResult(chatStore!, session, result);
      }
      sendJson(response, 200, result);
    } catch (error: any) {
      logger.error(`Messages API error: ${error}`);
      sendJson(response, 500, { error: error.message || 'Internal server error' });
    }
  });

  // GET /v1/models - List available models (OpenAI-compatible)
  server.get('/v1/models', async (request, response, _params) => {
    if (!chatService) {
      sendJson(response, 503, { error: 'Chat service not configured' });
      return;
    }

    try {
      const auth = request.auth;
      const models = await chatService.listModels(auth);
      sendJson(response, 200, {
        object: 'list',
        data: models,
      });
    } catch (error) {
      logger.error(`Failed to list models: ${error}`);
      sendJson(response, 500, { error: 'Failed to list models' });
    }
  });
}

interface ChatCompletionSession {
  thread: ThreadMetadata;
  threadRef: ThreadRef;
  context: StoreContext;
}

async function beginChatCompletionSession(
  store: ChatKitStore<StoreContext>,
  request: ChatCompletionRequest,
  auth: AuthContext,
  requestedThreadId?: string,
  source = 'openai.chat.completions',
): Promise<ChatCompletionSession> {
  const context: StoreContext = {
    userId: getWebId(auth) ?? getAccountId(auth) ?? 'anonymous',
    auth,
  };
  const latestInput = [...request.messages].reverse().find((message) =>
    message.role === 'user' || message.role === 'tool');
  const inputText = completionContentText(latestInput?.content);
  let thread: ThreadMetadata;

  if (requestedThreadId) {
    thread = await store.loadThread(toThreadRef({ thread_id: requestedThreadId }), context);
  } else {
    const id = store.generateThreadId(context);
    const now = nowTimestamp();
    thread = {
      id,
      parent: getThreadParent({ id })?.parent,
      title: inputText.slice(0, 50) || 'New Chat',
      status: { type: 'active' },
      reconcilerOwner: 'client',
      created_at: now,
      updated_at: now,
      metadata: {
        source,
        model: request.model,
        reconcilerOwner: 'client',
      },
    };
    await store.saveThread(thread, context);
  }

  const threadRef = { thread_id: thread.id };
  if (latestInput?.role === 'user') {
    const item: UserMessageItem = {
      id: store.generateItemId('user_message', thread, context),
      thread_id: thread.id,
      type: 'user_message',
      content: [{ type: 'input_text', text: inputText }],
      inference_options: {
        model: request.model,
        temperature: request.temperature,
        max_tokens: request.max_tokens,
        tools: request.tools,
        tool_choice: request.tool_choice as any,
      },
      created_at: nowTimestamp(),
    };
    await store.addThreadItem(threadRef, item, context);
  } else if (latestInput?.role === 'tool') {
    const item: ClientToolCallItem = {
      id: store.generateItemId('client_tool_call', thread, context),
      thread_id: thread.id,
      type: 'client_tool_call',
      name: typeof latestInput.name === 'string' ? latestInput.name : 'tool',
      arguments: '',
      call_id: typeof latestInput.tool_call_id === 'string' ? latestInput.tool_call_id : '',
      status: 'completed',
      output: inputText,
      created_at: nowTimestamp(),
    };
    await store.addThreadItem(threadRef, item, context);
  }

  return { thread, threadRef, context };
}

function responseBodyToCompletionRequest(body: unknown): ChatCompletionRequest | undefined {
  if (!body || typeof body !== 'object') {
    return undefined;
  }
  const payload = body as Record<string, any>;
  const inputs = Array.isArray(payload.input) ? payload.input : [payload.input];
  const messages = inputs.flatMap((input): ChatCompletionRequest['messages'] => {
    if (typeof input === 'string') {
      return [{ role: 'user', content: input }];
    }
    if (!input || typeof input !== 'object') {
      return [];
    }
    if (input.type === 'function_call_output') {
      return [{ role: 'tool', content: input.output, tool_call_id: input.call_id }];
    }
    return typeof input.role === 'string' ? [{ role: input.role, content: input.content }] : [];
  });
  return {
    ...payload,
    model: typeof payload.model === 'string' ? payload.model : 'unknown',
    messages,
  };
}

function messagesBodyToCompletionRequest(body: unknown): ChatCompletionRequest | undefined {
  if (!body || typeof body !== 'object') {
    return undefined;
  }
  const payload = body as Record<string, any>;
  const messages = Array.isArray(payload.messages)
    ? payload.messages.map((message: any) => {
      const toolResult = Array.isArray(message?.content)
        ? [...message.content].reverse().find((part: any) => part?.type === 'tool_result')
        : undefined;
      return toolResult
        ? { role: 'tool', content: toolResult.content, tool_call_id: toolResult.tool_use_id }
        : message;
    })
    : [];
  return {
    ...payload,
    model: typeof payload.model === 'string' ? payload.model : 'unknown',
    messages,
    max_tokens: payload.max_tokens,
  };
}

async function persistResponsesResult(
  store: ChatKitStore<StoreContext>,
  session: ChatCompletionSession,
  result: any,
): Promise<void> {
  const output = Array.isArray(result?.output) ? result.output : [];
  const text = typeof result?.output_text === 'string'
    ? result.output_text
    : output
      .filter((item: any) => item?.type === 'message')
      .map((item: any) => completionContentText(item.content))
      .join('\n');
  const toolCalls = output
    .filter((item: any) => item?.type === 'function_call')
    .map((item: any) => ({
      id: item.call_id ?? item.id,
      type: 'function',
      function: { name: item.name, arguments: item.arguments },
    }));
  await persistAssistantMessages(store, session, [{
    index: 0,
    message: { role: 'assistant', content: text, tool_calls: toolCalls },
    finish_reason: result?.status === 'incomplete' ? null : toolCalls.length > 0 ? 'tool_calls' : 'stop',
  }]);
}

async function persistMessagesResult(
  store: ChatKitStore<StoreContext>,
  session: ChatCompletionSession,
  result: any,
): Promise<void> {
  const content = Array.isArray(result?.content) ? result.content : [];
  const toolCalls = content
    .filter((part: any) => part?.type === 'tool_use')
    .map((part: any) => ({
      id: part.id,
      type: 'function',
      function: { name: part.name, arguments: JSON.stringify(part.input ?? {}) },
    }));
  await persistAssistantMessages(store, session, [{
    index: 0,
    message: { role: 'assistant', content: completionContentText(content), tool_calls: toolCalls },
    finish_reason: result?.stop_reason == null ? null : toolCalls.length > 0 ? 'tool_calls' : 'stop',
  }]);
}

async function persistAssistantMessages(
  store: ChatKitStore<StoreContext>,
  session: ChatCompletionSession,
  choices: ChatCompletionResponse['choices'],
): Promise<void> {
  for (const choice of choices) {
    const assistant: AssistantMessageItem = {
      id: store.generateItemId('assistant_message', session.thread, session.context),
      thread_id: session.thread.id,
      type: 'assistant_message',
      content: [{ type: 'output_text', text: completionContentText(choice.message.content) }],
      status: choice.finish_reason === null ? 'incomplete' : 'completed',
      created_at: nowTimestamp(),
    };
    await store.addThreadItem(session.threadRef, assistant, session.context);

    for (const toolCall of Array.isArray(choice.message.tool_calls) ? choice.message.tool_calls : []) {
      const call = toolCall as any;
      const toolItem: ClientToolCallItem = {
        id: store.generateItemId('client_tool_call', session.thread, session.context),
        thread_id: session.thread.id,
        type: 'client_tool_call',
        name: typeof call?.function?.name === 'string' ? call.function.name : 'tool',
        arguments: typeof call?.function?.arguments === 'string' ? call.function.arguments : '',
        call_id: typeof call?.id === 'string' ? call.id : '',
        status: 'pending',
        created_at: nowTimestamp(),
      };
      await store.addThreadItem(session.threadRef, toolItem, session.context);
    }
  }
}

function completionContentText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (part && typeof part === 'object' && typeof (part as any).text === 'string') {
          return (part as any).text;
        }
        if (part && typeof part === 'object' && (part as any).type === 'tool_result') {
          return completionContentText((part as any).content);
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return content == null ? '' : String(content);
}

function wrapCompletionStream(response: Response, onComplete: (text: string) => Promise<void>): Response {
  if (!response.body) {
    void onComplete('');
    return response;
  }

  const isEventStream = response.headers.get('content-type')?.toLowerCase().includes('text/event-stream') === true;
  const decoder = new TextDecoder();
  let assistantText = '';
  let lineBuffer = '';

  const consumeSseLines = (flush = false): void => {
    const lines = lineBuffer.split(/\r?\n/);
    lineBuffer = flush ? '' : lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data:')) {
        continue;
      }
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') {
        continue;
      }
      try {
        const event = JSON.parse(data);
        assistantText += completionContentText(event?.choices?.[0]?.delta?.content);
      } catch {
        // Ignore provider keepalive or non-JSON SSE data.
      }
    }
  };

  const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      const text = decoder.decode(chunk, { stream: true });
      if (isEventStream) {
        lineBuffer += text;
        consumeSseLines();
      } else {
        assistantText += text;
      }
    },
    async flush() {
      const trailing = decoder.decode();
      if (isEventStream) {
        lineBuffer += trailing;
        consumeSseLines(true);
      } else {
        assistantText += trailing;
      }
      await onComplete(assistantText);
    },
  }));

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function readHeader(request: AuthenticatedRequest, name: string): string | undefined {
  const value = request.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value?.trim() || undefined;
}

async function readJsonBody(request: AuthenticatedRequest): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      data += chunk;
    });
    request.on('end', () => {
      if (!data) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve(undefined);
      }
    });
    request.on('error', reject);
  });
}


function sendJson(response: ServerResponse, status: number, data: unknown): void {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(data));
}
