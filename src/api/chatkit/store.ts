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
import { generateId, getThreadIdFromRef, nowTimestamp } from './types';

/**
 * Context type for store operations (generic)
 */
export type StoreContext = Record<string, unknown>;

/**
 * Abstract Store interface
 */
export interface ChatKitStore<TContext = StoreContext> {
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
export class InMemoryStore<TContext = StoreContext> implements ChatKitStore<TContext> {
  private threads: Map<string, ThreadMetadata> = new Map();
  private items: Map<string, Map<string, ThreadItem>> = new Map(); // threadId -> (itemId -> item)
  private attachments: Map<string, Attachment> = new Map();

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

  // ID Generation
  generateThreadId(_context: TContext): string {
    return generateId('thread');
  }

  generateItemId(itemType: StoreItemType, _thread: ThreadMetadata, _context: TContext): string {
    return generateId(itemType);
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
    this.threads.set(key, { ...thread, updated_at: nowTimestamp() });
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
  }
}
