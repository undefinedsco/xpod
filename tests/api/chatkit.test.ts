/**
 * ChatKit API Tests
 * 
 * Tests for the ChatKit protocol implementation.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  ChatKitService,
  InMemoryStore,
  type AiProvider,
  type StoreContext,
} from '../../src/api/chatkit';

// Mock AI Provider for testing
class MockAiProvider implements AiProvider {
  async *streamResponse(
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    _options?: { model?: string; temperature?: number; maxTokens?: number; context?: unknown },
  ): AsyncIterable<string> {
    // Simulate streaming response
    const response = 'Hello! I am a mock assistant.';
    for (const char of response) {
      yield char;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }
}

describe('ChatKit Service', () => {
  let service: ChatKitService<StoreContext>;
  let store: InMemoryStore<StoreContext>;
  const context: StoreContext = { userId: 'test-user' };

  beforeAll(() => {
    store = new InMemoryStore();
    service = new ChatKitService({
      store,
      aiProvider: new MockAiProvider(),
      systemPrompt: 'You are a helpful test assistant.',
    });
  });

  afterAll(() => {
    store.clear();
  });

  describe('Thread Operations', () => {
    let threadId: string;

    it('should create a new thread', async () => {
      const request = JSON.stringify({
        type: 'threads.create',
        params: {},
      });

      const result = await service.process(request, context);
      expect(result.type).toBe('streaming');

      if (result.type === 'streaming') {
        const events: any[] = [];
        const decoder = new TextDecoder();
        
        for await (const chunk of result.stream()) {
          const text = decoder.decode(chunk);
          const lines = text.split('\n\n').filter(Boolean);
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = JSON.parse(line.slice(6));
              events.push(data);
            }
          }
        }

        // Should have thread.created event
        const createdEvent = events.find((e) => e.type === 'thread.created');
        expect(createdEvent).toBeDefined();
        expect(createdEvent.thread.id).toBeDefined();
        expect(createdEvent.thread.status.type).toBe('active');

        threadId = createdEvent.thread.id;
      }
    });

    it('should create a thread with initial message', async () => {
      const request = JSON.stringify({
        type: 'threads.create',
        params: {
          input: {
            content: [{ type: 'input_text', text: 'Hello, assistant!' }],
          },
        },
      });

      const result = await service.process(request, context);
      expect(result.type).toBe('streaming');

      if (result.type === 'streaming') {
        const events: any[] = [];
        const decoder = new TextDecoder();
        
        for await (const chunk of result.stream()) {
          const text = decoder.decode(chunk);
          const lines = text.split('\n\n').filter(Boolean);
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = JSON.parse(line.slice(6));
              events.push(data);
            }
          }
        }

        // Should have thread.created, item.added (user), item.added (assistant), item.done events
        expect(events.some((e) => e.type === 'thread.created')).toBe(true);
        expect(events.some((e) => e.type === 'thread.item.added' && e.item?.type === 'user_message')).toBe(true);
        expect(events.some((e) => e.type === 'thread.item.added' && e.item?.type === 'assistant_message')).toBe(true);
        expect(events.some((e) => e.type === 'thread.item.done')).toBe(true);

        // Check text delta updates
        const textDeltas = events.filter(
          (e) => e.type === 'thread.item.updated' && e.update?.type === 'assistant_message.content_part.text_delta'
        );
        expect(textDeltas.length).toBeGreaterThan(0);

        threadId = events.find((e) => e.type === 'thread.created')?.thread.id;
      }
    });

    it('should get thread by id', async () => {
      // First create a thread
      const createRequest = JSON.stringify({
        type: 'threads.create',
        params: {},
      });

      const createResult = await service.process(createRequest, context);
      let newThreadId: string = '';
      
      if (createResult.type === 'streaming') {
        const decoder = new TextDecoder();
        for await (const chunk of createResult.stream()) {
          const text = decoder.decode(chunk);
          const match = text.match(/"thread\.created".*?"id":"([^"]+)"/);
          if (match) {
            newThreadId = match[1];
            break;
          }
        }
      }

      // Now get the thread
      const getRequest = JSON.stringify({
        type: 'threads.get_by_id',
        params: { thread_id: newThreadId },
      });

      const result = await service.process(getRequest, context);
      expect(result.type).toBe('non_streaming');

      if (result.type === 'non_streaming') {
        const data = JSON.parse(result.json);
        expect(data.id).toBe(newThreadId);
        expect(data.status.type).toBe('active');
        expect(data.items).toBeDefined();
      }
    });

    it('should list threads', async () => {
      const request = JSON.stringify({
        type: 'threads.list',
        params: { limit: 10 },
      });

      const result = await service.process(request, context);
      expect(result.type).toBe('non_streaming');

      if (result.type === 'non_streaming') {
        const data = JSON.parse(result.json);
        expect(data.data).toBeInstanceOf(Array);
        expect(data.has_more).toBeDefined();
      }
    });

    it('should update thread title', async () => {
      // First create a thread
      const createRequest = JSON.stringify({
        type: 'threads.create',
        params: {},
      });

      const createResult = await service.process(createRequest, context);
      let newThreadId: string = '';
      
      if (createResult.type === 'streaming') {
        const decoder = new TextDecoder();
        for await (const chunk of createResult.stream()) {
          const text = decoder.decode(chunk);
          const match = text.match(/"thread\.created".*?"id":"([^"]+)"/);
          if (match) {
            newThreadId = match[1];
            break;
          }
        }
      }

      // Update the title
      const updateRequest = JSON.stringify({
        type: 'threads.update',
        params: { thread_id: newThreadId, title: 'Test Thread' },
      });

      const result = await service.process(updateRequest, context);
      expect(result.type).toBe('non_streaming');

      if (result.type === 'non_streaming') {
        const data = JSON.parse(result.json);
        expect(data.title).toBe('Test Thread');
      }
    });

    it('should delete thread', async () => {
      // First create a thread
      const createRequest = JSON.stringify({
        type: 'threads.create',
        params: {},
      });

      const createResult = await service.process(createRequest, context);
      let newThreadId: string = '';
      
      if (createResult.type === 'streaming') {
        const decoder = new TextDecoder();
        for await (const chunk of createResult.stream()) {
          const text = decoder.decode(chunk);
          const match = text.match(/"thread\.created".*?"id":"([^"]+)"/);
          if (match) {
            newThreadId = match[1];
            break;
          }
        }
      }

      // Delete the thread
      const deleteRequest = JSON.stringify({
        type: 'threads.delete',
        params: { thread_id: newThreadId },
      });

      const result = await service.process(deleteRequest, context);
      expect(result.type).toBe('non_streaming');

      if (result.type === 'non_streaming') {
        const data = JSON.parse(result.json);
        expect(data.success).toBe(true);
      }

      // Verify thread is deleted
      const getRequest = JSON.stringify({
        type: 'threads.get_by_id',
        params: { thread_id: newThreadId },
      });

      await expect(service.process(getRequest, context)).rejects.toThrow();
    });
  });

  describe('Message Operations', () => {
    let threadId: string;

    beforeAll(async () => {
      // Create a thread for message tests
      const createRequest = JSON.stringify({
        type: 'threads.create',
        params: {},
      });

      const result = await service.process(createRequest, context);
      if (result.type === 'streaming') {
        const decoder = new TextDecoder();
        for await (const chunk of result.stream()) {
          const text = decoder.decode(chunk);
          const match = text.match(/"thread\.created".*?"id":"([^"]+)"/);
          if (match) {
            threadId = match[1];
            break;
          }
        }
      }
    });

    it('should add user message and get response', async () => {
      const request = JSON.stringify({
        type: 'threads.add_user_message',
        params: {
          thread_id: threadId,
          input: {
            content: [{ type: 'input_text', text: 'What is 2 + 2?' }],
          },
        },
      });

      const result = await service.process(request, context);
      expect(result.type).toBe('streaming');

      if (result.type === 'streaming') {
        const events: any[] = [];
        const decoder = new TextDecoder();
        
        for await (const chunk of result.stream()) {
          const text = decoder.decode(chunk);
          const lines = text.split('\n\n').filter(Boolean);
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = JSON.parse(line.slice(6));
              events.push(data);
            }
          }
        }

        // Should have user message added
        const userMsgEvent = events.find(
          (e) => e.type === 'thread.item.added' && e.item?.type === 'user_message'
        );
        expect(userMsgEvent).toBeDefined();

        // Should have assistant message
        const assistantMsgEvent = events.find(
          (e) => e.type === 'thread.item.added' && e.item?.type === 'assistant_message'
        );
        expect(assistantMsgEvent).toBeDefined();
      }
    });

    it('should list items in thread', async () => {
      const request = JSON.stringify({
        type: 'items.list',
        params: { thread_id: threadId, limit: 50 },
      });

      const result = await service.process(request, context);
      expect(result.type).toBe('non_streaming');

      if (result.type === 'non_streaming') {
        const data = JSON.parse(result.json);
        expect(data.data).toBeInstanceOf(Array);
        expect(data.data.length).toBeGreaterThan(0);
      }
    });

    it('should handle feedback', async () => {
      // Get items first
      const listRequest = JSON.stringify({
        type: 'items.list',
        params: { thread_id: threadId, limit: 50 },
      });

      const listResult = await service.process(listRequest, context);
      let itemId: string = '';
      
      if (listResult.type === 'non_streaming') {
        const data = JSON.parse(listResult.json);
        const assistantMsg = data.data.find((i: any) => i.type === 'assistant_message');
        if (assistantMsg) {
          itemId = assistantMsg.id;
        }
      }

      if (itemId) {
        const request = JSON.stringify({
          type: 'items.feedback',
          params: {
            thread_id: threadId,
            item_ids: [itemId],
            feedback: 'positive',
          },
        });

        const result = await service.process(request, context);
        expect(result.type).toBe('non_streaming');

        if (result.type === 'non_streaming') {
          const data = JSON.parse(result.json);
          expect(data.success).toBe(true);
        }
      }
    });
  });

  describe('Error Handling', () => {
    it('should handle invalid JSON', async () => {
      await expect(service.process('invalid json', context)).rejects.toThrow('Invalid JSON');
    });

    it('should handle unknown request type', async () => {
      const request = JSON.stringify({
        type: 'unknown.type',
        params: {},
      });

      // Should not throw, but may return error event
      const result = await service.process(request, context);
      // The service should handle unknown types gracefully
    });

    it('should handle non-existent thread', async () => {
      const request = JSON.stringify({
        type: 'threads.get_by_id',
        params: { thread_id: 'non-existent-thread' },
      });

      await expect(service.process(request, context)).rejects.toThrow('Thread not found');
    });
  });
});
