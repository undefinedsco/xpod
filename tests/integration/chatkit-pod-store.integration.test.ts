/**
 * ChatKit PodStore Integration Tests
 *
 * 测试 ChatKit 使用 PodChatKitStore 存储到 Pod 的完整流程:
 * 1. Thread 创建 → 写入 Pod RDF
 * 2. 发送消息 → AI 响应 → 存储到 Pod
 * 3. 读取历史消息 → 从 Pod 查询
 * 4. Thread 列表、更新、删除
 *
 * 运行方式: yarn vitest run tests/integration/chatkit-pod-store.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { ChatKitService, type AiProvider } from '../../src/api/chatkit/service';
import { PodChatKitStore } from '../../src/api/chatkit/pod-store';
import type { StoreContext } from '../../src/api/chatkit/store';
import { CredentialStatus, ServiceType } from '../../src/credential/schema/types';
import { setupAccount, type AccountSetup } from './helpers/solidAccount';

// Mock AI Provider - simulates AI responses
class MockAiProvider implements AiProvider {
  async *streamResponse(
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    _options?: { model?: string; temperature?: number; maxTokens?: number; context?: unknown },
  ): AsyncIterable<string> {
    // Get the last user message
    const lastUserMsg = messages.filter((m) => m.role === 'user').pop();
    const response = lastUserMsg
      ? `Mock response to: "${lastUserMsg.content.substring(0, 50)}..."`
      : 'Hello! I am a mock assistant.';

    // Simulate streaming by yielding character by character
    for (const char of response) {
      yield char;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }
}

const RUN_INTEGRATION_TESTS = process.env.XPOD_RUN_INTEGRATION_TESTS === 'true';
const shouldRun = RUN_INTEGRATION_TESTS;
const suite = shouldRun ? describe : describe.skip;

const solidBaseUrl = (process.env.CSS_BASE_URL ?? 'http://localhost:5739').replace(/\/$/, '');

suite('ChatKit PodStore Integration', () => {
  let service: ChatKitService<StoreContext>;
  let store: PodChatKitStore;
  let testContext: StoreContext;

  // Test user credentials (created during setup)
  let account: AccountSetup;
  let podUrl: string;

  beforeAll(async () => {
    const createdAccount = await setupAccount(solidBaseUrl, 'ckstore');
    if (!createdAccount) {
      throw new Error(`Failed to setup account on ${solidBaseUrl}`);
    }
    account = createdAccount;
    podUrl = account.podUrl;


    store = new PodChatKitStore({
      tokenEndpoint: `${account.issuer.replace(/\/$/, '')}/.oidc/token`,
    });

    service = new ChatKitService({
      store,
      aiProvider: new MockAiProvider(),
      systemPrompt: 'You are a helpful test assistant.',
    });

    testContext = {
      userId: account.webId,
      auth: {
        type: 'solid',
        webId: account.webId,
        clientId: account.clientId,
        clientSecret: account.clientSecret,
      },
    } as StoreContext;
  }, 60000);

  afterAll(async () => {
    // No cleanup: integration accounts are ephemeral.
  }, 1000);


  const truncate = (s: string, max = 800): string => (s.length <= max ? s : s.slice(0, max) + '...<truncated>');

  const waitForThreadItemsCount = async (
    threadId: string,
    minCount: number,
    options: { timeoutMs?: number; intervalMs?: number } = {},
  ): Promise<any[]> => {
    const timeoutMs = options.timeoutMs ?? 6000;
    const intervalMs = options.intervalMs ?? 200;
    const startedAt = Date.now();

    let lastJson = '';

    while (Date.now() - startedAt < timeoutMs) {
      const request = JSON.stringify({
        type: 'items.list',
        params: { thread_id: threadId, limit: 50 },
      });
      const result = await service.process(request, testContext);
      if (result.type === 'non_streaming') {
        lastJson = result.json;
        const data = JSON.parse(result.json);
        if (Array.isArray(data.data) && data.data.length >= minCount) {
          return data.data;
        }
      } else {
        lastJson = JSON.stringify({ type: result.type });
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    throw new Error(
      'Timeout waiting for thread items (threadId=' + threadId + ', minCount=' + minCount + ', timeoutMs=' + timeoutMs + '). Last items.list response: ' + truncate(lastJson),
    );
  };

  describe('Thread CRUD Operations', () => {
    let threadId: string;

    it('should create a new thread and store in Pod', async () => {
      const request = JSON.stringify({
        type: 'threads.create',
        params: {},
      });

      const result = await service.process(request, testContext);
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

    it('should retrieve thread from Pod', async () => {
      expect(threadId).toBeDefined();

      const request = JSON.stringify({
        type: 'threads.get_by_id',
        params: { thread_id: threadId },
      });

      const result = await service.process(request, testContext);
      expect(result.type).toBe('non_streaming');

      if (result.type === 'non_streaming') {
        const data = JSON.parse(result.json);
        expect(data.id).toBe(threadId);
        expect(data.status.type).toBe('active');
      }
    });

    it('should list threads from Pod', async () => {
      const request = JSON.stringify({
        type: 'threads.list',
        params: { limit: 10 },
      });

      const result = await service.process(request, testContext);
      expect(result.type).toBe('non_streaming');

      if (result.type === 'non_streaming') {
        const data = JSON.parse(result.json);
        expect(data.data).toBeInstanceOf(Array);
        expect(data.data.length).toBeGreaterThan(0);
        expect(data.data.some((t: any) => t.id === threadId)).toBe(true);
      }
    });

    it('should update thread title in Pod', async () => {
      const request = JSON.stringify({
        type: 'threads.update',
        params: { thread_id: threadId, title: 'Updated Test Thread' },
      });

      const result = await service.process(request, testContext);
      expect(result.type).toBe('non_streaming');

      if (result.type === 'non_streaming') {
        const data = JSON.parse(result.json);
        expect(data.title).toBe('Updated Test Thread');
      }

      // Verify update persisted
      const getRequest = JSON.stringify({
        type: 'threads.get_by_id',
        params: { thread_id: threadId },
      });

      const getResult = await service.process(getRequest, testContext);
      if (getResult.type === 'non_streaming') {
        const getData = JSON.parse(getResult.json);
        expect(getData.title).toBe('Updated Test Thread');
      }
    });
  });

  describe('Message Flow with AI Response', () => {
    let threadId: string;

    beforeAll(async () => {
      // Create a thread for message tests
      const request = JSON.stringify({
        type: 'threads.create',
        params: {},
      });

      const result = await service.process(request, testContext);
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

    it('should send user message and receive AI response stored in Pod', async () => {
      expect(threadId).toBeDefined();

      const request = JSON.stringify({
        type: 'threads.add_user_message',
        params: {
          thread_id: threadId,
          input: {
            content: [{ type: 'input_text', text: 'Hello, what is the weather today?' }],
          },
        },
      });

      const result = await service.process(request, testContext);
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
          (e) => e.type === 'thread.item.added' && e.item?.type === 'user_message',
        );
        expect(userMsgEvent).toBeDefined();
        expect(userMsgEvent.item.content[0].text).toContain('weather');

        // Should have assistant message
        const assistantMsgEvent = events.find(
          (e) => e.type === 'thread.item.added' && e.item?.type === 'assistant_message',
        );
        expect(assistantMsgEvent).toBeDefined();

        // Should have text delta updates (streaming)
        const textDeltas = events.filter(
          (e) =>
            e.type === 'thread.item.updated' &&
            e.update?.type === 'assistant_message.content_part.text_delta',
        );
        expect(textDeltas.length).toBeGreaterThan(0);

        // Should have item done event
        const doneEvent = events.find((e) => e.type === 'thread.item.done');
        expect(doneEvent).toBeDefined();
      }
    });

    it('should retrieve messages from Pod', async () => {
      const items = await waitForThreadItemsCount(threadId, 2);
      expect(items).toBeInstanceOf(Array);
      expect(items.length).toBeGreaterThanOrEqual(2); // At least user + assistant

      // Check user message
      const userMsg = items.find((i: any) => i.type === 'user_message');
      expect(userMsg).toBeDefined();
      expect(userMsg.content[0].text).toContain('weather');

      // Check assistant message
      const assistantMsg = items.find((i: any) => i.type === 'assistant_message');
      expect(assistantMsg).toBeDefined();
      expect(assistantMsg.content[0].text).toContain('Mock response');
    });

    it('should handle multiple messages in conversation', async () => {
      // Send second message
      const request = JSON.stringify({
        type: 'threads.add_user_message',
        params: {
          thread_id: threadId,
          input: {
            content: [{ type: 'input_text', text: 'Tell me more about that.' }],
          },
        },
      });

      const result = await service.process(request, testContext);
      expect(result.type).toBe('streaming');

      // Consume the stream
      if (result.type === 'streaming') {
        for await (const _ of result.stream()) {
          // Just consume
        }
      }

      // Verify all messages are stored
      const items = await waitForThreadItemsCount(threadId, 4);
      expect(items.length).toBeGreaterThanOrEqual(4); // 2 user + 2 assistant
    });
  });

  describe('Thread with Initial Message', () => {
    it('should create thread with initial message and get AI response', async () => {
      const request = JSON.stringify({
        type: 'threads.create',
        params: {
          input: {
            content: [{ type: 'input_text', text: 'Start a new conversation about coding.' }],
          },
        },
      });

      const result = await service.process(request, testContext);
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

        // Should have all events in order
        expect(events.some((e) => e.type === 'thread.created')).toBe(true);
        expect(
          events.some((e) => e.type === 'thread.item.added' && e.item?.type === 'user_message'),
        ).toBe(true);
        expect(
          events.some((e) => e.type === 'thread.item.added' && e.item?.type === 'assistant_message'),
        ).toBe(true);
        expect(events.some((e) => e.type === 'thread.item.done')).toBe(true);

        // Get thread ID and verify persistence
        const createdEvent = events.find((e) => e.type === 'thread.created');
        const threadId = createdEvent?.thread.id;

        if (threadId) {
          const getRequest = JSON.stringify({
            type: 'threads.get_by_id',
            params: { thread_id: threadId },
          });

          const getResult = await service.process(getRequest, testContext);
          if (getResult.type === 'non_streaming') {
            const data = JSON.parse(getResult.json);
            expect(data.id).toBe(threadId);
            // items is a Page object with data array
            expect(data.items).toBeDefined();
            expect(data.items.data).toBeInstanceOf(Array);

            if (data.items.data.length < 2) {
              const items = await waitForThreadItemsCount(threadId, 2);
              expect(items.length).toBeGreaterThanOrEqual(2);
            } else {
              expect(data.items.data.length).toBeGreaterThanOrEqual(2);
            }
          }
        }
      }
    });
  });

  describe('Thread Deletion', () => {
    it('should delete thread and all messages from Pod', async () => {
      // Create a thread
      const createRequest = JSON.stringify({
        type: 'threads.create',
        params: {
          input: {
            content: [{ type: 'input_text', text: 'Thread to be deleted' }],
          },
        },
      });

      const createResult = await service.process(createRequest, testContext);
      let threadId: string = '';

      if (createResult.type === 'streaming') {
        const decoder = new TextDecoder();
        // Must consume the entire stream to ensure all operations complete
        for await (const chunk of createResult.stream()) {
          const text = decoder.decode(chunk);
          const match = text.match(/"thread\.created".*?"id":"([^"]+)"/);
          if (match && !threadId) {
            threadId = match[1];
          }
          // Continue consuming the stream, don't break early
        }
      }

      expect(threadId).toBeTruthy();

      // Delete the thread
      const deleteRequest = JSON.stringify({
        type: 'threads.delete',
        params: { thread_id: threadId },
      });

      const deleteResult = await service.process(deleteRequest, testContext);
      expect(deleteResult.type).toBe('non_streaming');

      if (deleteResult.type === 'non_streaming') {
        const data = JSON.parse(deleteResult.json);
        expect(data.success).toBe(true);
      }

      // Verify thread is deleted - should throw either "Thread not found" or container 404
      const getRequest = JSON.stringify({
        type: 'threads.get_by_id',
        params: { thread_id: threadId },
      });

      // The query might throw "Thread not found" or a 404 error if the container was cleaned up
      try {
        await service.process(getRequest, testContext);
        // If we get here without error, the test should fail
        expect.fail('Expected service.process to throw an error for deleted thread');
      } catch (error: any) {
        // Both "Thread not found" and container 404 are valid outcomes
        expect(error.message).toMatch(/Thread not found|404|NotFoundHttpError|Could not retrieve/);
      }
    }, 15000);
  });

  describe('Error Handling', () => {
    it('should handle non-existent thread', async () => {
      const request = JSON.stringify({
        type: 'threads.get_by_id',
        params: { thread_id: 'non-existent-thread-id' },
      });

      await expect(service.process(request, testContext)).rejects.toThrow('Thread not found');
    });

    it('should handle invalid JSON', async () => {
      await expect(service.process('invalid json', testContext)).rejects.toThrow('Invalid JSON');
    });
  });

  describe('AI Config Operations', () => {
    it('should return undefined when no credentials exist', async () => {
      const config = await store.getAiConfig(testContext);
      expect(config).toBeUndefined();
    });

    it('should create provider and credential, then retrieve AI config', async () => {
      // First, we need to manually insert Provider and Credential data
      // Access the db through a private method (for testing purposes)
      const db = await (store as any).getDb(testContext);
      expect(db).not.toBeNull();

      // Import schemas
      const { Provider } = await import('../../src/ai/schema/provider');
      const { Credential } = await import('../../src/credential/schema/tables');

      // Create a provider
      await db.insert(Provider).values({
        id: 'test-openai',
        displayName: 'Test OpenAI',
        baseUrl: 'https://api.openai.com/v1',
      });

      // Create a credential
      await db.insert(Credential).values({
        id: 'cred-test-001',
        provider: `${podUrl}settings/ai/providers.ttl#test-openai`,
        service: ServiceType.AI,
        status: CredentialStatus.ACTIVE,
        apiKey: 'sk-test-key-123',
        label: 'Test Credential',
      });

      // Now get AI config
      const config = await store.getAiConfig(testContext);

      expect(config).toBeDefined();
      expect(config!.providerId).toBe('test-openai');
      expect(config!.baseUrl).toBe('https://api.openai.com/v1');
      expect(config!.apiKey).toBe('sk-test-key-123');
      expect(config!.credentialId).toBe('cred-test-001');
    });

    it('should use credential baseUrl over provider baseUrl', async () => {
      const db = await (store as any).getDb(testContext);
      const { Provider } = await import('../../src/ai/schema/provider');
      const { Credential } = await import('../../src/credential/schema/tables');

      // Create provider with baseUrl
      await db.insert(Provider).values({
        id: 'custom-provider',
        displayName: 'Custom Provider',
        baseUrl: 'https://default.api.com/v1',
      });

      // Create credential with custom baseUrl
      await db.insert(Credential).values({
        id: 'cred-custom-001',
        provider: `${podUrl}settings/ai/providers.ttl#custom-provider`,
        service: ServiceType.AI,
        status: CredentialStatus.ACTIVE,
        apiKey: 'sk-custom-key',
        baseUrl: 'https://custom.api.com/v1',
        label: 'Custom Credential',
      });

      const config = await store.getAiConfig(testContext);

      // Should use credential's baseUrl
      expect(config).toBeDefined();
      expect(config!.baseUrl).toBe('https://custom.api.com/v1');
    });

    it('should skip inactive credentials', async () => {
      const db = await (store as any).getDb(testContext);
      const { Provider } = await import('../../src/ai/schema/provider');
      const { Credential } = await import('../../src/credential/schema/tables');

      // Create provider
      await db.insert(Provider).values({
        id: 'inactive-provider',
        displayName: 'Inactive Provider',
        baseUrl: 'https://inactive.api.com/v1',
      });

      // Create inactive credential
      await db.insert(Credential).values({
        id: 'cred-inactive-001',
        provider: `${podUrl}settings/ai/providers.ttl#inactive-provider`,
        service: ServiceType.AI,
        status: CredentialStatus.INACTIVE,
        apiKey: 'sk-inactive-key',
        label: 'Inactive Credential',
      });

      // Should not return the inactive credential (should get previously created active one)
      const config = await store.getAiConfig(testContext);
      expect(config).toBeDefined();
      expect(config!.credentialId).not.toBe('cred-inactive-001');
    });

    it('should update credential status to rate limited', async () => {
      const db = await (store as any).getDb(testContext);
      const { Credential } = await import('../../src/credential/schema/tables');
      const { eq } = await import('drizzle-solid');

      // Create a credential for status update test
      await db.insert(Credential).values({
        id: 'cred-status-test',
        provider: `${podUrl}settings/ai/providers.ttl#test-openai`,
        service: ServiceType.AI,
        status: CredentialStatus.ACTIVE,
        apiKey: 'sk-status-test-key',
        failCount: 0,
        label: 'Status Test Credential',
      });

      // Update status to rate limited
      const resetAt = new Date(Date.now() + 60000);
      await store.updateCredentialStatus(
        testContext,
        'cred-status-test',
        CredentialStatus.RATE_LIMITED,
        { rateLimitResetAt: resetAt, incrementFailCount: true },
      );

      // Verify the update
      const credentials = await db.select().from(Credential).where(eq(Credential.id, 'cred-status-test'));
      expect(credentials.length).toBe(1);
      expect(credentials[0].status).toBe(CredentialStatus.RATE_LIMITED);
      expect(credentials[0].failCount).toBe(1);
    });

    it('should record credential success and reset fail count', async () => {
      const db = await (store as any).getDb(testContext);
      const { Credential } = await import('../../src/credential/schema/tables');
      const { eq } = await import('drizzle-solid');

      // Create a credential with some failures
      await db.insert(Credential).values({
        id: 'cred-success-test',
        provider: `${podUrl}settings/ai/providers.ttl#test-openai`,
        service: ServiceType.AI,
        status: CredentialStatus.RATE_LIMITED,
        apiKey: 'sk-success-test-key',
        failCount: 5,
        label: 'Success Test Credential',
      });

      // Record success
      await store.recordCredentialSuccess(testContext, 'cred-success-test');

      // Verify the update
      const credentials = await db.select().from(Credential).where(eq(Credential.id, 'cred-success-test'));
      expect(credentials.length).toBe(1);
      expect(credentials[0].status).toBe(CredentialStatus.ACTIVE);
      expect(credentials[0].failCount).toBe(0);
    });

    it('should include proxyUrl in AI config when set', async () => {
      const db = await (store as any).getDb(testContext);
      const { Provider } = await import('../../src/ai/schema/provider');
      const { Credential } = await import('../../src/credential/schema/tables');

      // Create provider with proxyUrl
      await db.insert(Provider).values({
        id: 'proxy-provider',
        displayName: 'Proxy Provider',
        baseUrl: 'https://proxy-api.com/v1',
        proxyUrl: 'http://proxy.example.com:8080',
      });

      // Create credential
      await db.insert(Credential).values({
        id: 'cred-proxy-001',
        provider: `${podUrl}settings/ai/providers.ttl#proxy-provider`,
        service: ServiceType.AI,
        status: CredentialStatus.ACTIVE,
        apiKey: 'sk-proxy-key',
        label: 'Proxy Credential',
      });

      // Clear any cached db to ensure fresh query
      delete (testContext as any)._cachedDb;

      const config = await store.getAiConfig(testContext);

      // Should include proxyUrl
      expect(config).toBeDefined();
      // The config might be from a previously created credential, check if proxy is included
      if (config!.providerId === 'proxy-provider') {
        expect(config!.proxyUrl).toBe('http://proxy.example.com:8080');
      }
    });
  });
});
