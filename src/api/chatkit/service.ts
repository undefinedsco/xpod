/**
 * ChatKit Service
 * 
 * Core service for handling ChatKit protocol requests.
 * Based on https://github.com/openai/chatkit-python/blob/main/chatkit/server.py
 */

import { getLoggerFor } from 'global-logger-factory';
import type { ChatKitStore, StoreContext } from './store';
import type {
  ChatKitReq,
  StreamingReq,
  NonStreamingReq,
  ThreadCreateParams,
  ThreadAddUserMessageParams,
  ThreadAddClientToolOutputParams,
  ThreadRetryAfterItemParams,
  ThreadCustomActionParams,
  ThreadGetByIdParams,
  ItemsListParams,
  ItemFeedbackParams,
  ThreadUpdateParams,
  ThreadDeleteParams,
  ThreadMetadata,
  ThreadRef,
  ThreadItem,
  UserMessageItem,
  AssistantMessageItem,
  ThreadStreamEvent,
  ThreadCreatedEvent,
  ThreadItemAddedEvent,
  ThreadItemDoneEvent,
  ThreadItemUpdatedEvent,
  Page,
  Thread,
  UserMessageContent,
  ClientToolCallItem,
} from './types';
import {
  DEFAULT_THREAD_CHAT_ID,
  getChatIdFromThreadMetadata,
  getThreadIdFromRef,
  isStreamingReq,
  generateId,
  nowTimestamp,
  toThreadRef,
  extractUserMessageText,
} from './types';
import { PtyThreadRuntime, type PtyRuntimeConfig, type RunnerType } from './runtime/PtyThreadRuntime';

/**
 * AI Provider interface for generating responses
 */
export interface AiProvider {
  /**
   * Stream a response for the given messages
   * Returns an async iterator of text chunks
   */
  streamResponse(
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    options?: {
      model?: string;
      temperature?: number;
      maxTokens?: number;
      context?: unknown; // Allow passing context for auth
    },
  ): AsyncIterable<string>;
}

/**
 * ChatKit Service Options
 */
export interface ChatKitServiceOptions<TContext = StoreContext> {
  store: ChatKitStore<TContext>;
  aiProvider: AiProvider;
  systemPrompt?: string;
  /**
   * Enable xpod PTY runtime threads (local-only feature).
   * When enabled, thread.metadata.runtime controls the runner/worktree.
   */
  enablePtyRuntime?: boolean;
}

/**
 * Streaming result wrapper
 */
export interface StreamingResult {
  type: 'streaming';
  stream(): AsyncIterable<Uint8Array>;
}

/**
 * Non-streaming result wrapper
 */
export interface NonStreamingResult {
  type: 'non_streaming';
  json: string;
}

export type ChatKitResult = StreamingResult | NonStreamingResult;

/**
 * ChatKit Service
 */
export class ChatKitService<TContext = StoreContext> {
  private readonly logger = getLoggerFor(this);
  private readonly store: ChatKitStore<TContext>;
  private readonly aiProvider: AiProvider;
  private readonly systemPrompt: string;
  private readonly enablePtyRuntime: boolean;
  private readonly ptyRuntime: PtyThreadRuntime;

  public constructor(options: ChatKitServiceOptions<TContext>) {
    this.store = options.store;
    this.aiProvider = options.aiProvider;
    this.systemPrompt = options.systemPrompt ?? 'You are a helpful assistant.';
    this.enablePtyRuntime = options.enablePtyRuntime ?? false;
    this.ptyRuntime = new PtyThreadRuntime();
  }

  /**
   * Process a ChatKit request
   */
  public async process(requestBody: string | Buffer, context: TContext): Promise<ChatKitResult> {
    const requestStr = typeof requestBody === 'string' ? requestBody : requestBody.toString('utf-8');
    
    let request: ChatKitReq;
    try {
      request = JSON.parse(requestStr) as ChatKitReq;
    } catch (e) {
      throw new Error('Invalid JSON request body');
    }

    this.logger.debug(`Processing ChatKit request: ${request.type}`);

    if (isStreamingReq(request)) {
      return {
        type: 'streaming',
        stream: () => this.processStreamingAsBytes(request, context),
      };
    } else {
      const result = await this.processNonStreaming(request, context);
      return {
        type: 'non_streaming',
        json: JSON.stringify(result),
      };
    }
  }

  /**
   * Convert streaming events to SSE bytes
   */
  private async *processStreamingAsBytes(request: StreamingReq, context: TContext): AsyncIterable<Uint8Array> {
    const encoder = new TextEncoder();
    try {
      for await (const event of this.processStreaming(request, context)) {
        const data = JSON.stringify(event);
        yield encoder.encode(`data: ${data}\n\n`);
      }
    } catch (error: any) {
      const errorEvent: ThreadStreamEvent = {
        type: 'error',
        error: {
          code: 'internal_error',
          message: error.message || 'An error occurred',
        },
      };
      yield encoder.encode(`data: ${JSON.stringify(errorEvent)}\n\n`);
    }
  }

  /**
   * Process streaming requests
   */
  private async *processStreaming(request: StreamingReq, context: TContext): AsyncIterable<ThreadStreamEvent> {
    switch (request.type) {
      case 'threads.create':
        yield* this.handleThreadsCreate(request.params, context, request.metadata);
        break;
      case 'threads.add_user_message':
        yield* this.handleThreadsAddUserMessage(request.params, context);
        break;
      case 'threads.add_client_tool_output':
        yield* this.handleThreadsAddClientToolOutput(request.params, context);
        break;
      case 'threads.retry_after_item':
        yield* this.handleThreadsRetryAfterItem(request.params, context);
        break;
      case 'threads.custom_action':
        yield* this.handleThreadsCustomAction(request.params, context);
        break;
    }
  }

  /**
   * Process non-streaming requests
   */
  private async processNonStreaming(request: NonStreamingReq, context: TContext): Promise<unknown> {
    switch (request.type) {
      case 'threads.get_by_id':
        return this.handleThreadsGetById(request.params, context);
      case 'threads.list':
        return this.handleThreadsList(request.params, context);
      case 'items.list':
        return this.handleItemsList(request.params, context);
      case 'items.feedback':
        return this.handleItemsFeedback(request.params, context);
      case 'attachments.create':
        return this.handleAttachmentsCreate(request.params, context);
      case 'attachments.delete':
        return this.handleAttachmentsDelete(request.params, context);
      case 'threads.update':
        return this.handleThreadsUpdate(request.params, context);
      case 'threads.delete':
        return this.handleThreadsDelete(request.params, context);
    }
  }

  // =========================================================================
  // Streaming Request Handlers
  // =========================================================================

  /**
   * Handle threads.create - Create a new thread and optionally respond to initial message
   */
  private async *handleThreadsCreate(
    params: ThreadCreateParams,
    context: TContext,
    metadata?: Record<string, unknown>,
  ): AsyncIterable<ThreadStreamEvent> {
    // Create new thread
    const threadId = this.store.generateThreadId(context);
    const now = nowTimestamp();
    
    const thread: ThreadMetadata = {
      id: threadId,
      status: { type: 'active' },
      created_at: now,
      updated_at: now,
      metadata: this.normalizeThreadMetadata(metadata, params.chat_id),
    };

    await this.store.saveThread(thread, context);

    // Emit thread created event
    yield {
      type: 'thread.created',
      thread,
    } as ThreadCreatedEvent;

    // If input provided, add user message and respond
    if (params.input) {
      const threadRef = this.threadRefFromThread(thread);
      const userMessage = await this.createUserMessage(threadRef, params.input.content, context, thread);
      await this.store.addThreadItem(threadRef, userMessage, context);

      yield {
        type: 'thread.item.added',
        item: userMessage,
      } as ThreadItemAddedEvent;

      yield {
        type: 'thread.item.done',
        item: userMessage,
      } as ThreadItemDoneEvent;

      // Generate response (AI or PTY)
      yield* this.respond(thread, userMessage, context, params.input.inference_options);
    }
  }

  /**
   * Handle threads.add_user_message - Add a user message and respond
   */
  private async *handleThreadsAddUserMessage(
    params: ThreadAddUserMessageParams,
    context: TContext,
  ): AsyncIterable<ThreadStreamEvent> {
    const threadRef = this.threadRefFromParams(params);
    const thread = await this.store.loadThread(threadRef, context);

    // Create and save user message
    const userMessage = await this.createUserMessage(threadRef, params.input.content, context);
    await this.store.addThreadItem(threadRef, userMessage, context);

    yield {
      type: 'thread.item.added',
      item: userMessage,
    } as ThreadItemAddedEvent;

    yield {
      type: 'thread.item.done',
      item: userMessage,
    } as ThreadItemDoneEvent;

    // Generate response (AI or PTY)
    yield* this.respond(thread, userMessage, context, params.input.inference_options, threadRef);
  }

  /**
   * Handle threads.add_client_tool_output - Handle tool output (not fully implemented)
   */
  private async *handleThreadsAddClientToolOutput(
    params: ThreadAddClientToolOutputParams,
    context: TContext,
  ): AsyncIterable<ThreadStreamEvent> {
    const threadRef = this.threadRefFromParams(params);
    const threadId = getThreadIdFromRef(threadRef);
    // Update the tool call item with output
    const item = await this.store.loadItem(threadRef, params.item_id, context);
    
    if (item.type === 'client_tool_call') {
      const updatedItem = {
        ...item,
        output: params.output,
        status: 'completed' as const,
      };
      await this.store.saveItem(threadRef, updatedItem, context);

      yield {
        type: 'thread.item.done',
        item: updatedItem,
      } as ThreadItemDoneEvent;

      // ACP tool-call continuation: respond to the pending ACP request and stream follow-up output.
      try {
        const thread = await this.store.loadThread(threadRef, context);
        const ptyConfig = this.getPtyConfig(thread);
        let assistantItem: AssistantMessageItem | undefined;
        let assistantText = '';

        const idleMs = ptyConfig?.idleMs ?? 500;
        for await (
          const ev of this.ptyRuntime.respondToRequest(
            threadId,
            item.call_id,
            params.output,
            { idleMs, authWaitMs: ptyConfig?.authWaitMs },
          )
        ) {
          if (ev.type === 'text') {
            if (!assistantItem) {
              const assistantId = this.store.generateItemId('assistant_message', thread, context);
              assistantItem = {
                id: assistantId,
                thread_id: threadId,
                type: 'assistant_message',
                content: [{ type: 'output_text', text: '' }],
                status: 'in_progress',
                created_at: nowTimestamp(),
              };
              await this.store.addThreadItem(threadRef, assistantItem, context);
              yield { type: 'thread.item.added', item: assistantItem } as ThreadItemAddedEvent;
            }

            assistantText += ev.text;
            yield {
              type: 'thread.item.updated',
              item_id: assistantItem.id,
              update: {
                type: 'assistant_message.content_part.text_delta',
                part_index: 0,
                delta: ev.text,
              },
            } as ThreadItemUpdatedEvent;
            continue;
          }

          if (ev.type === 'auth_required') {
            yield {
              type: 'client_effect',
              effect: {
                effect_type: 'runtime.auth_required',
                data: {
                  method: ev.method,
                  url: ev.url,
                  message: ev.message,
                  options: ev.options,
                },
              },
            };
            continue;
          }

          if (ev.type === 'tool_call') {
            const toolItem: ClientToolCallItem = {
              id: this.store.generateItemId('client_tool_call', thread, context),
              thread_id: threadId,
              type: 'client_tool_call',
              name: ev.name,
              arguments: ev.arguments,
              call_id: ev.requestId,
              status: 'pending',
              created_at: nowTimestamp(),
            };
            await this.store.addThreadItem(threadRef, toolItem, context);
            yield { type: 'thread.item.added', item: toolItem } as ThreadItemAddedEvent;
          }
        }

        if (assistantItem) {
          const completedItem: AssistantMessageItem = {
            ...assistantItem,
            content: [{ type: 'output_text', text: assistantText }],
            status: 'completed',
          };
          await this.store.saveItem(threadRef, completedItem, context);
          yield { type: 'thread.item.done', item: completedItem } as ThreadItemDoneEvent;
        }
      } catch {
        // Ignore: non-runtime tool calls.
      }
    }
  }

  /**
   * Handle threads.retry_after_item - Retry generation after a specific item
   */
  private async *handleThreadsRetryAfterItem(
    params: ThreadRetryAfterItemParams,
    context: TContext,
  ): AsyncIterable<ThreadStreamEvent> {
    const threadRef = this.threadRefFromParams(params);
    const thread = await this.store.loadThread(threadRef, context);
    
    // Load all items and find the last user message before the retry point
    const items = await this.store.loadThreadItems(threadRef, undefined, 1000, 'asc', context);
    
    let lastUserMessage: UserMessageItem | undefined;
    for (const item of items.data) {
      if (item.id === params.item_id) {
        break;
      }
      if (item.type === 'user_message') {
        lastUserMessage = item;
      }
    }

    if (lastUserMessage) {
      yield* this.respond(thread, lastUserMessage, context, undefined, threadRef);
    }
  }

  /**
   * Handle threads.custom_action - Handle custom widget actions (not fully implemented)
   */
  private async *handleThreadsCustomAction(
    params: ThreadCustomActionParams,
    context: TContext,
  ): AsyncIterable<ThreadStreamEvent> {
    this.logger.info(`Custom action: ${params.action} on item ${params.item_id}`);
    // Custom actions can be implemented based on specific needs
  }

  // =========================================================================
  // Non-Streaming Request Handlers
  // =========================================================================

  /**
   * Handle threads.get_by_id
   */
  private async handleThreadsGetById(
    params: ThreadGetByIdParams,
    context: TContext,
  ): Promise<Thread> {
    const threadRef = this.threadRefFromParams(params);
    const thread = await this.store.loadThread(threadRef, context);
    const items = await this.store.loadThreadItems(threadRef, undefined, 50, 'asc', context);
    
    return {
      ...thread,
      items,
    };
  }

  /**
   * Handle threads.list
   */
  private async handleThreadsList(
    params: { limit?: number; order?: string; after?: string } | undefined,
    context: TContext,
  ): Promise<Page<ThreadMetadata>> {
    return this.store.loadThreads(
      params?.limit ?? 20,
      params?.after,
      params?.order ?? 'desc',
      context,
    );
  }

  /**
   * Handle items.list
   */
  private async handleItemsList(
    params: ItemsListParams,
    context: TContext,
  ): Promise<Page<ThreadItem>> {
    return this.store.loadThreadItems(
      this.threadRefFromParams(params),
      params.after,
      params.limit ?? 50,
      params.order ?? 'asc',
      context,
    );
  }

  /**
   * Handle items.feedback (acknowledge only for now)
   */
  private async handleItemsFeedback(
    params: ItemFeedbackParams,
    context: TContext,
  ): Promise<{ success: boolean }> {
    this.logger.info(`Feedback received: ${params.feedback} for items ${params.item_ids.join(', ')}`);
    // Store feedback in metadata or separate table if needed
    return { success: true };
  }

  /**
   * Handle attachments.create
   */
  private async handleAttachmentsCreate(
    params: { name: string; size: number; mime_type: string },
    context: TContext,
  ): Promise<{ attachment_id: string; upload_url?: string }> {
    const attachmentId = generateId('attach');
    // For now, return a placeholder - actual upload handling would need S3/MinIO integration
    return {
      attachment_id: attachmentId,
      // upload_url would be provided for actual file upload
    };
  }

  /**
   * Handle attachments.delete
   */
  private async handleAttachmentsDelete(
    params: { attachment_id: string },
    context: TContext,
  ): Promise<{ success: boolean }> {
    if (this.store.deleteAttachment) {
      await this.store.deleteAttachment(params.attachment_id, context);
    }
    return { success: true };
  }

  /**
   * Handle threads.update
   */
  private async handleThreadsUpdate(
    params: ThreadUpdateParams,
    context: TContext,
  ): Promise<ThreadMetadata> {
    const threadRef = this.threadRefFromParams(params);
    const thread = await this.store.loadThread(threadRef, context);
    
    if (params.title !== undefined) {
      thread.title = params.title;
    }
    thread.updated_at = nowTimestamp();

    await this.store.saveThread(thread, context);
    return thread;
  }

  /**
   * Handle threads.delete
   */
  private async handleThreadsDelete(
    params: ThreadDeleteParams,
    context: TContext,
  ): Promise<{ success: boolean }> {
    await this.store.deleteThread(this.threadRefFromParams(params), context);
    return { success: true };
  }

  // =========================================================================
  // Core Response Generation
  // =========================================================================

  /**
   * Generate AI response for a user message
   * This is the main response generation logic
   */
  private async *respond(
    thread: ThreadMetadata,
    userMessage: UserMessageItem,
    context: TContext,
    inferenceOptions?: any,
    threadRef: ThreadRef = this.threadRefFromThread(thread),
  ): AsyncIterable<ThreadStreamEvent> {
    const ptyConfig = this.getPtyConfig(thread);
    if (ptyConfig) {
      yield* this.respondWithPty(thread, userMessage, context, ptyConfig);
      return;
    }

    // Build conversation history
    const messages = await this.buildConversationHistory(threadRef, context);
    
    // Create assistant message item
    const assistantItemId = this.store.generateItemId('assistant_message', thread, context);
    const assistantItem: AssistantMessageItem = {
      id: assistantItemId,
      thread_id: thread.id,
      type: 'assistant_message',
      content: [{ type: 'output_text', text: '' }],
      status: 'in_progress',
      created_at: nowTimestamp(),
    };

    await this.store.addThreadItem(threadRef, assistantItem, context);

    // Emit item added event
    yield {
      type: 'thread.item.added',
      item: assistantItem,
    } as ThreadItemAddedEvent;

    // Stream AI response
    let fullText = '';
    let partIndex = 0;

    try {
      for await (const chunk of this.aiProvider.streamResponse(messages, {
        model: inferenceOptions?.model,
        temperature: inferenceOptions?.temperature,
        maxTokens: inferenceOptions?.max_tokens,
        context, // Pass context for auth
      })) {
        fullText += chunk;

        // Emit text delta update
        yield {
          type: 'thread.item.updated',
          item_id: assistantItemId,
          update: {
            type: 'assistant_message.content_part.text_delta',
            part_index: partIndex,
            delta: chunk,
          },
        } as ThreadItemUpdatedEvent;
      }

      // Update item with full content
      assistantItem.content = [{ type: 'output_text', text: fullText }];
      assistantItem.status = 'completed';
      await this.store.saveItem(threadRef, assistantItem, context);

      // Emit item done event
      yield {
        type: 'thread.item.done',
        item: assistantItem,
      } as ThreadItemDoneEvent;
    } catch (error: any) {
      this.logger.error(`AI response generation failed: ${error}`);

      assistantItem.content = [{ type: 'output_text', text: 'Sorry, an error occurred while generating the response.' }];
      assistantItem.status = 'incomplete';
      await this.store.saveItem(threadRef, assistantItem, context);

      yield {
        type: 'thread.item.done',
        item: assistantItem,
      } as ThreadItemDoneEvent;

      yield {
        type: 'error',
        error: {
          code: 'generation_error',
          message: error.message || 'Failed to generate response',
        },
      };
    }

    // Auto-generate title if this is the first exchange (outside try/catch to not affect message saving)
    if (!thread.title) {
      try {
        const title = this.generateThreadTitle(userMessage, fullText);
        thread.title = title;
        thread.updated_at = nowTimestamp();
        await this.store.saveThread(thread, context);

        yield {
          type: 'thread.updated',
          thread,
        };
      } catch (titleError: any) {
        this.logger.warn(`Failed to auto-generate thread title: ${titleError.message}`);
        // Don't throw - title generation failure shouldn't affect the response
      }
    }
  }

  private getPtyConfig(thread: ThreadMetadata): PtyRuntimeConfig | null {
    if (!this.enablePtyRuntime) {
      return null;
    }
    const runtime = (thread.metadata as any)?.runtime;
    if (!runtime) {
      return null;
    }
    if (!runtime.workspace || !runtime.runner) {
      throw new Error('Invalid thread.metadata.runtime: workspace/runner are required');
    }
    const runnerType = runtime.runner.type as RunnerType;
    if (!runnerType) {
      throw new Error('Invalid thread.metadata.runtime.runner.type');
    }
    // Enforce ACP-only: raw/stdio mode is removed.
    const protocol = 'acp';
    // Keep runner args server-owned by default, unless explicitly allowed.
    // This avoids exposing per-runner argv details to end users.
    const allowCustomArgv = runtime.runner.allowCustomArgv === true;
    const argv = allowCustomArgv ? runtime.runner.argv : undefined;
    return {
      ...runtime,
      runner: {
        ...runtime.runner,
        argv,
        protocol,
      },
      agentConfig: runtime.agentConfig,
    } as PtyRuntimeConfig;
  }

  private async *respondWithPty(
    thread: ThreadMetadata,
    userMessage: UserMessageItem,
    context: TContext,
    ptyConfig: PtyRuntimeConfig,
  ): AsyncIterable<ThreadStreamEvent> {
    const userText = extractUserMessageText(userMessage.content);
    if (!userText.trim()) {
      return;
    }

    const threadRef = this.threadRefFromThread(thread);

    await this.ptyRuntime.ensureStarted(thread.id, ptyConfig);

    const assistantId = this.store.generateItemId('assistant_message', thread, context);
    const assistantItem: AssistantMessageItem = {
      id: assistantId,
      thread_id: thread.id,
      type: 'assistant_message',
      content: [{ type: 'output_text', text: '' }],
      status: 'in_progress',
      created_at: nowTimestamp(),
    };

    await this.store.addThreadItem(threadRef, assistantItem, context);
    yield { type: 'thread.item.added', item: assistantItem } as ThreadItemAddedEvent;

    let fullText = '';
    let sawRuntimeError: string | undefined;
    const idleMs = ptyConfig.idleMs ?? 500;
    for await (const ev of this.ptyRuntime.sendMessage(thread.id, userText, { idleMs, authWaitMs: ptyConfig.authWaitMs })) {
      if (ev.type === 'text') {
        fullText += ev.text;
        yield {
          type: 'thread.item.updated',
          item_id: assistantId,
          update: {
            type: 'assistant_message.content_part.text_delta',
            part_index: 0,
            delta: ev.text,
          },
        } as ThreadItemUpdatedEvent;
        continue;
      }

      if (ev.type === 'error') {
        sawRuntimeError = ev.message;
        yield {
          type: 'error',
          error: {
            code: 'runtime_error',
            message: ev.message,
          },
        } as ThreadStreamEvent;
        break;
      }

      if (ev.type === 'auth_required') {
        // Runtime-only. Do not persist sensitive auth details into thread history.
        yield {
          type: 'client_effect',
          effect: {
            effect_type: 'runtime.auth_required',
            data: {
              method: ev.method,
              url: ev.url,
              message: ev.message,
              options: ev.options,
            },
          },
        };
        continue;
      }

      if (ev.type === 'tool_call') {
        const toolItem: ClientToolCallItem = {
          id: this.store.generateItemId('client_tool_call', thread, context),
          thread_id: thread.id,
          type: 'client_tool_call',
          name: ev.name,
          arguments: ev.arguments,
          call_id: ev.requestId,
          status: 'pending',
          created_at: nowTimestamp(),
        };
        await this.store.addThreadItem(threadRef, toolItem, context);
        yield { type: 'thread.item.added', item: toolItem } as ThreadItemAddedEvent;

        // Pause: client must call threads.add_client_tool_output to continue.
        const incomplete: AssistantMessageItem = {
          ...assistantItem,
          content: [{ type: 'output_text', text: fullText }],
          status: 'incomplete',
        };
        await this.store.saveItem(threadRef, incomplete, context);
        yield { type: 'thread.item.done', item: incomplete } as ThreadItemDoneEvent;
        return;
      }
    }

    if (sawRuntimeError) {
      const incomplete: AssistantMessageItem = {
        ...assistantItem,
        content: [{ type: 'output_text', text: fullText }],
        status: 'incomplete',
      };
      await this.store.saveItem(threadRef, incomplete, context);
      yield { type: 'thread.item.done', item: incomplete } as ThreadItemDoneEvent;
      return;
    }

    const completedItem: AssistantMessageItem = {
      ...assistantItem,
      content: [{ type: 'output_text', text: fullText }],
      status: 'completed',
    };
    await this.store.saveItem(threadRef, completedItem, context);
    yield { type: 'thread.item.done', item: completedItem } as ThreadItemDoneEvent;
  }

  /**
   * Build conversation history from thread items
   */
  private async buildConversationHistory(
    thread: ThreadRef,
    context: TContext,
  ): Promise<Array<{ role: 'system' | 'user' | 'assistant'; content: string }>> {
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];

    // Add system prompt
    messages.push({ role: 'system', content: this.systemPrompt });

    // Load thread items
    const items = await this.store.loadThreadItems(thread, undefined, 100, 'asc', context);

    for (const item of items.data) {
      if (item.type === 'user_message') {
        const text = extractUserMessageText(item.content);
        if (text) {
          messages.push({ role: 'user', content: text });
        }
      } else if (item.type === 'assistant_message') {
        const text = item.content
          .filter((c) => c.type === 'output_text')
          .map((c) => c.text)
          .join('\n');
        if (text) {
          messages.push({ role: 'assistant', content: text });
        }
      }
    }

    return messages;
  }

  /**
   * Create a user message item
   */
  private async createUserMessage(
    threadRef: ThreadRef,
    content: UserMessageContent[],
    context: TContext,
    thread?: ThreadMetadata,
  ): Promise<UserMessageItem> {
    // Use provided thread or load it
    const threadMeta = thread || await this.store.loadThread(threadRef, context);
    const threadId = getThreadIdFromRef(threadRef);
    const itemId = this.store.generateItemId('user_message', threadMeta, context);

    return {
      id: itemId,
      thread_id: threadId,
      type: 'user_message',
      content,
      created_at: nowTimestamp(),
    };
  }

  /**
   * Generate a title for the thread based on the first exchange
   */
  private generateThreadTitle(userMessage: UserMessageItem, assistantResponse: string): string {
    const userText = extractUserMessageText(userMessage.content);
    // Use the first 50 chars of user message as title
    let title = userText.slice(0, 50);
    if (userText.length > 50) {
      title += '...';
    }
    return title || 'New Chat';
  }

  private normalizeThreadMetadata(
    metadata: Record<string, unknown> | undefined,
    chatId?: string,
  ): Record<string, unknown> | undefined {
    const normalized = { ...(metadata ?? {}) };
    normalized.chat_id = chatId
      ?? (typeof normalized.chat_id === 'string' && normalized.chat_id.length > 0
        ? normalized.chat_id
        : DEFAULT_THREAD_CHAT_ID);
    return Object.keys(normalized).length > 0 ? normalized : undefined;
  }

  private threadRefFromParams(params: { thread_id: string; chat_id?: string }): ThreadRef {
    return toThreadRef(params);
  }

  private threadRefFromThread(thread: ThreadMetadata): ThreadRef {
    return {
      thread_id: thread.id,
      chat_id: getChatIdFromThreadMetadata(thread),
    };
  }
}
