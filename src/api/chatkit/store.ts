/**
 * ChatKit Store Interface
 * 
 * Abstract interface for persisting threads and items.
 * Based on https://github.com/openai/chatkit-python/blob/main/chatkit/store.py
 */

import type {
  ThreadMetadata,
  ThreadRef,
  ThreadItem,
  Attachment,
  Page,
  StoreItemType,
} from './types';
import { generateId, getThreadIdFromRef, getThreadParent, nowTimestamp } from './types';
import {
  buildRunResourceId,
  buildRunStepResourceId,
  canClaimRun,
  isRunResourceId,
  type RunListOptions,
  type RunRecordData,
  type RunStepRecordData,
  type RunStore,
} from '../runs/store';
import { buildTaskResourceId, type TaskListOptions, type TaskRecordData, type TaskStore } from '../tasks/store';
import {
  TASK_AUTH_CREDENTIAL_SERVICE,
  type TaskAuthBindingRepository,
  type TaskAuthCredentialRecord,
} from '../tasks/TaskAuthBinding';

/**
 * Context type for store operations (generic)
 */
export type StoreContext = Record<string, unknown>;

/**
 * Abstract Store interface
 */
export interface ChatKitStore<TContext = StoreContext> extends Partial<RunStore<TContext>> {
  // ID Generation
  generateThreadId(context: TContext): string;
  generateItemId(itemType: StoreItemType, thread: ThreadMetadata, context: TContext): string;

  // Thread operations
  loadThread(thread: ThreadRef, context: TContext): Promise<ThreadMetadata>;
  saveThread(thread: ThreadMetadata, context: TContext): Promise<void>;
  loadThreads(limit: number, after: string | undefined, order: string, context: TContext): Promise<Page<ThreadMetadata>>;
  deleteThread(thread: ThreadRef, context: TContext): Promise<void>;

  // Thread Item operations
  loadThreadItems(thread: ThreadRef, after: string | undefined, limit: number, order: string, context: TContext): Promise<Page<ThreadItem>>;
  addThreadItem(thread: ThreadRef, item: ThreadItem, context: TContext): Promise<void>;
  saveItem(thread: ThreadRef, item: ThreadItem, context: TContext): Promise<void>;
  loadItem(thread: ThreadRef, itemId: string, context: TContext): Promise<ThreadItem>;
  deleteThreadItem(thread: ThreadRef, itemId: string, context: TContext): Promise<void>;

  // Attachment operations (optional)
  saveAttachment?(attachment: Attachment, context: TContext): Promise<void>;
  loadAttachment?(attachmentId: string, context: TContext): Promise<Attachment>;
  deleteAttachment?(attachmentId: string, context: TContext): Promise<void>;
}

/**
 * In-Memory Store Implementation
 * 
 * Simple in-memory store for development and testing.
 * Data is lost when the server restarts.
 */
export class InMemoryStore<TContext = StoreContext> implements ChatKitStore<TContext>, TaskStore<TContext>, TaskAuthBindingRepository<TContext & StoreContext> {
  private threads: Map<string, ThreadMetadata> = new Map();
  private items: Map<string, Map<string, ThreadItem>> = new Map(); // threadId -> (itemId -> item)
  private attachments: Map<string, Attachment> = new Map();
  private runs: Map<string, RunRecordData> = new Map();
  private runSteps: Map<string, RunStepRecordData[]> = new Map();
  private tasks: Map<string, TaskRecordData> = new Map();
  private taskAuthCredentials: Map<string, TaskAuthCredentialRecord> = new Map();

  // Store per-user data using a key from context
  private getUserKey(context: TContext): string {
    const userId = (context as Record<string, unknown>).userId;
    return typeof userId === 'string' ? userId : 'default';
  }

  private getThreadKey(threadId: string, context: TContext): string {
    return `${this.getUserKey(context)}:${threadId}`;
  }

  private normalizeThreadId(thread: ThreadRef): string {
    return getThreadIdFromRef(thread);
  }

  private stripThreadProtocolMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
    if (!metadata) {
      return undefined;
    }
    const stripped = { ...metadata };
    delete stripped.chat_id;
    delete stripped.surface_id;
    delete stripped.commandKind;
    delete stripped.parent;
    return Object.keys(stripped).length > 0 ? stripped : undefined;
  }

  // ID Generation
  generateThreadId(_context: TContext): string {
    return `chat/default/index.ttl#${generateId('thread')}`;
  }

  generateItemId(itemType: StoreItemType, thread: ThreadMetadata, _context: TContext): string {
    const parent = getThreadParent(thread);
    const storageKind = parent?.kind ?? 'chat';
    const storageKey = parent?.key ?? 'default';
    const date = new Date();
    const yyyy = String(date.getUTCFullYear());
    const MM = String(date.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(date.getUTCDate()).padStart(2, '0');
    return `${storageKind}/${storageKey}/${yyyy}/${MM}/${dd}/messages.ttl#${generateId(itemType)}`;
  }

  // Thread operations
  async loadThread(thread: ThreadRef, context: TContext): Promise<ThreadMetadata> {
    const threadId = this.normalizeThreadId(thread);
    const key = this.getThreadKey(threadId, context);
    const threadData = this.threads.get(key);
    if (!threadData) {
      throw new Error(`Thread not found: ${threadId}`);
    }
    return threadData;
  }

  async saveThread(thread: ThreadMetadata, context: TContext): Promise<void> {
    const key = this.getThreadKey(thread.id, context);
    this.threads.set(key, {
      ...thread,
      parent: thread.parent ?? getThreadParent(thread)?.parent,
      metadata: this.stripThreadProtocolMetadata(thread.metadata),
      updated_at: nowTimestamp(),
    });
  }

  async loadThreads(limit: number, after: string | undefined, order: string, context: TContext): Promise<Page<ThreadMetadata>> {
    const userKey = this.getUserKey(context);
    const prefix = `${userKey}:`;
    
    // Get all threads for this user
    const userThreads: ThreadMetadata[] = [];
    for (const [key, thread] of this.threads) {
      if (key.startsWith(prefix)) {
        userThreads.push(thread);
      }
    }

    // Sort by created_at
    userThreads.sort((a, b) => {
      return order === 'desc' ? b.created_at - a.created_at : a.created_at - b.created_at;
    });

    // Apply pagination
    let startIndex = 0;
    if (after) {
      const afterIndex = userThreads.findIndex((t) => t.id === after);
      if (afterIndex !== -1) {
        startIndex = afterIndex + 1;
      }
    }

    const slice = userThreads.slice(startIndex, startIndex + limit);
    const hasMore = startIndex + limit < userThreads.length;

    return {
      data: slice,
      has_more: hasMore,
      after: slice.length > 0 ? slice[slice.length - 1].id : undefined,
    };
  }

  async deleteThread(thread: ThreadRef, context: TContext): Promise<void> {
    const threadId = this.normalizeThreadId(thread);
    const key = this.getThreadKey(threadId, context);
    this.threads.delete(key);
    this.items.delete(key);
  }

  // Thread Item operations
  async loadThreadItems(thread: ThreadRef, after: string | undefined, limit: number, order: string, context: TContext): Promise<Page<ThreadItem>> {
    const threadId = this.normalizeThreadId(thread);
    const key = this.getThreadKey(threadId, context);
    const threadItems = this.items.get(key);
    
    if (!threadItems) {
      return { data: [], has_more: false };
    }

    const itemList = Array.from(threadItems.values());
    
    // Sort by created_at
    itemList.sort((a, b) => {
      return order === 'desc' ? b.created_at - a.created_at : a.created_at - b.created_at;
    });

    // Apply pagination
    let startIndex = 0;
    if (after) {
      const afterIndex = itemList.findIndex((item) => item.id === after);
      if (afterIndex !== -1) {
        startIndex = afterIndex + 1;
      }
    }

    const slice = itemList.slice(startIndex, startIndex + limit);
    const hasMore = startIndex + limit < itemList.length;

    return {
      data: slice,
      has_more: hasMore,
      after: slice.length > 0 ? slice[slice.length - 1].id : undefined,
    };
  }

  async addThreadItem(thread: ThreadRef, item: ThreadItem, context: TContext): Promise<void> {
    const threadId = this.normalizeThreadId(thread);
    const key = this.getThreadKey(threadId, context);
    let threadItems = this.items.get(key);
    if (!threadItems) {
      threadItems = new Map();
      this.items.set(key, threadItems);
    }
    threadItems.set(item.id, item);
  }

  async saveItem(thread: ThreadRef, item: ThreadItem, context: TContext): Promise<void> {
    await this.addThreadItem(thread, item, context);
  }

  async loadItem(thread: ThreadRef, itemId: string, context: TContext): Promise<ThreadItem> {
    const threadId = this.normalizeThreadId(thread);
    const key = this.getThreadKey(threadId, context);
    const threadItems = this.items.get(key);
    if (!threadItems) {
      throw new Error(`Thread not found: ${threadId}`);
    }
    const item = threadItems.get(itemId);
    if (!item) {
      throw new Error(`Item not found: ${itemId}`);
    }
    return item;
  }

  async deleteThreadItem(thread: ThreadRef, itemId: string, context: TContext): Promise<void> {
    const threadId = this.normalizeThreadId(thread);
    const key = this.getThreadKey(threadId, context);
    const threadItems = this.items.get(key);
    if (threadItems) {
      threadItems.delete(itemId);
    }
  }

  // Attachment operations
  async saveAttachment(attachment: Attachment, _context: TContext): Promise<void> {
    this.attachments.set(attachment.id, attachment);
  }

  async loadAttachment(attachmentId: string, _context: TContext): Promise<Attachment> {
    const attachment = this.attachments.get(attachmentId);
    if (!attachment) {
      throw new Error(`Attachment not found: ${attachmentId}`);
    }
    return attachment;
  }

  async deleteAttachment(attachmentId: string, _context: TContext): Promise<void> {
    this.attachments.delete(attachmentId);
  }

  async saveRun(run: RunRecordData, context: TContext): Promise<void> {
    run.id = buildRunResourceId(run.id);
    this.runs.set(this.getRunKey(run.id, context), { ...run });
  }

  async loadRun(runId: string, context: TContext): Promise<RunRecordData> {
    const run = this.runs.get(this.getRunKey(runId, context));
    if (!run) {
      throw new Error(`Run not found: ${runId}`);
    }
    return { ...run };
  }

  async listRuns(options: RunListOptions, context: TContext): Promise<RunRecordData[]> {
    const userKey = this.getUserKey(context);
    const prefix = `${userKey}:`;
    let runs = Array.from(this.runs.entries())
      .filter(([key]) => key.startsWith(prefix))
      .map(([, run]) => ({ ...run }));

    if (options.task) {
      runs = runs.filter((run) => run.task === options.task);
    }
    if (options.thread) {
      runs = runs.filter((run) => run.thread === options.thread);
    }
    if (options.workspace) {
      runs = runs.filter((run) => run.workspace === options.workspace);
    }
    if (options.status) {
      runs = runs.filter((run) => run.status === options.status);
    }

    runs.sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
    return runs.slice(0, options.limit ?? runs.length);
  }

  async appendRunStep(event: RunStepRecordData, context: TContext): Promise<void> {
    if (!isRunResourceId(event.runId)) {
      throw new Error(`RunStep runId must be a complete Run resource id: ${event.runId}`);
    }
    event.id = buildRunStepResourceId(event.id);
    const key = this.getRunKey(event.runId, context);
    const events = this.runSteps.get(key) ?? [];
    events.push({ ...event });
    this.runSteps.set(key, events);
  }

  async loadRunSteps(runId: string, context: TContext): Promise<RunStepRecordData[]> {
    return [...(this.runSteps.get(this.getRunKey(runId, context)) ?? [])];
  }

  async claimRun(input: {
    runId: string;
    leaseOwner: string;
    leaseExpiresAt: number;
    now: number;
  }, context: TContext): Promise<RunRecordData | undefined> {
    const key = this.getRunKey(input.runId, context);
    const run = this.runs.get(key);
    if (!run || !canClaimRun(run, input)) {
      return undefined;
    }
    const claimed = {
      ...run,
      leaseOwner: input.leaseOwner,
      leaseExpiresAt: input.leaseExpiresAt,
      heartbeatAt: input.now,
      updatedAt: input.now,
    };
    this.runs.set(key, claimed);
    return { ...claimed };
  }

  async saveTask(task: TaskRecordData, context: TContext): Promise<void> {
    task.id = buildTaskResourceId(task.id);
    this.tasks.set(this.getTaskKey(task.id, context), {
      ...task,
      metadata: this.withAuthBindingMetadata(task.metadata, task.authBinding),
    });
  }

  async loadTask(taskId: string, context: TContext): Promise<TaskRecordData> {
    const task = this.tasks.get(this.getTaskKey(taskId, context));
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }
    return { ...task };
  }

  async listTasks(options: TaskListOptions, context: TContext): Promise<TaskRecordData[]> {
    const userKey = this.getUserKey(context);
    const prefix = `${userKey}:`;
    const dueAt = options.dueAt ?? nowTimestamp();
    let tasks = Array.from(this.tasks.entries())
      .filter(([key]) => key.startsWith(prefix))
      .map(([, task]) => ({ ...task }));

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
  }, context: TContext & StoreContext): Promise<TaskAuthCredentialRecord> {
    const record: TaskAuthCredentialRecord = {
      id: input.id,
      service: TASK_AUTH_CREDENTIAL_SERVICE,
      status: 'active',
      apiKey: input.apiKey,
      label: input.displayName,
      oauthExpiresAt: input.expiresAt ? new Date(input.expiresAt * 1000).toISOString() : undefined,
      createdAt: new Date().toISOString(),
    };
    this.taskAuthCredentials.set(this.getTaskAuthCredentialKey(input.id, context), record);
    return { ...record };
  }

  async loadTaskAuthCredential(id: string, context: TContext & StoreContext): Promise<TaskAuthCredentialRecord | undefined> {
    const record = this.taskAuthCredentials.get(this.getTaskAuthCredentialKey(id, context));
    return record ? { ...record } : undefined;
  }

  private withAuthBindingMetadata(
    metadata: Record<string, unknown> | undefined,
    authBinding: TaskRecordData['authBinding'],
  ): Record<string, unknown> | undefined {
    if (!authBinding) {
      return metadata;
    }
    return {
      ...(metadata ?? {}),
      authBinding,
    };
  }

  // Utility methods for debugging
  getStats(): { threads: number; items: number; attachments: number } {
    let totalItems = 0;
    for (const threadItems of this.items.values()) {
      totalItems += threadItems.size;
    }
    return {
      threads: this.threads.size,
      items: totalItems,
      attachments: this.attachments.size,
    };
  }

  clear(): void {
    this.threads.clear();
    this.items.clear();
    this.attachments.clear();
    this.runs.clear();
    this.runSteps.clear();
    this.tasks.clear();
    this.taskAuthCredentials.clear();
  }

  private getRunKey(runId: string, context: TContext): string {
    return `${this.getUserKey(context)}:${runId}`;
  }

  private getTaskKey(taskId: string, context: TContext): string {
    return `${this.getUserKey(context)}:${taskId}`;
  }

  private getTaskAuthCredentialKey(id: string, context: TContext): string {
    return `${this.getUserKey(context)}:${id}`;
  }
}
