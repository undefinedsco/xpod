import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'node:net';
import { ApiServer } from '../../src/api/ApiServer';
import { AuthMiddleware } from '../../src/api/middleware/AuthMiddleware';
import { registerChatKitV1Routes } from '../../src/api/handlers/ChatKitV1Handler';
import { InMemoryStore } from '../../src/api/chatkit/store';
import type { StoreContext } from '../../src/api/chatkit/store';
import type { ThreadMetadata, UserMessageItem } from '../../src/api/chatkit/types';

const authMiddleware = new AuthMiddleware({
  authenticator: {
    canAuthenticate: () => true,
    authenticate: async () => ({
      success: true,
      context: { type: 'solid', webId: 'https://example.com/user#me', accountId: 'user-1' },
    }),
  } as any,
});

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const tester = createServer();
    tester.once('error', reject);
    tester.listen(0, '127.0.0.1', () => {
      const address = tester.address();
      if (!address || typeof address === 'string') {
        tester.close(() => reject(new Error('Failed to resolve free port')));
        return;
      }
      const port = address.port;
      tester.close((closeError) => {
        if (closeError) {
          reject(closeError);
          return;
        }
        resolve(port);
      });
    });
  });
}

const TEST_THREAD_ID = 'chat/default/index.ttl#thread_test_1';
const TEST_THREAD_SEGMENT = encodeURIComponent(TEST_THREAD_ID);

describe('ChatKitV1Handler Integration', () => {
  let server: ApiServer;
  let baseUrl: string;
  let store: InMemoryStore<StoreContext>;

  beforeAll(async () => {
    const port = await getFreePort();
    baseUrl = 'http://localhost:' + port;
    server = new ApiServer({ port, authMiddleware });

    store = new InMemoryStore<StoreContext>();
    registerChatKitV1Routes(server, { store });
    await server.start();

    const ctx: StoreContext = { userId: 'https://example.com/user#me', auth: { type: 'solid' } as any };
    const now = Math.floor(Date.now() / 1000);
    const thread: ThreadMetadata = {
      id: TEST_THREAD_ID,
      title: 't1',
      status: { type: 'active' },
      created_at: now,
      updated_at: now,
    };
    await store.saveThread(thread, ctx);
    const item: UserMessageItem = {
      id: 'item_1',
      thread_id: thread.id,
      type: 'user_message',
      created_at: now,
      content: [{ type: 'input_text', text: 'hello' }],
    };
    await store.addThreadItem({ thread_id: thread.id }, item, ctx);
  });

  afterAll(async () => {
    await server.stop();
  });

  it('lists threads at /v1/chatkit/threads', async () => {
    const res = await fetch(baseUrl + '/v1/chatkit/threads?limit=10', {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.object).toBe('list');
    expect(Array.isArray(json.data)).toBe(true);
    expect(json.data.length).toBeGreaterThanOrEqual(1);
    expect(json.data[0].object).toBe('chatkit.thread');
  });

  it('retrieves thread at /v1/chatkit/threads/:id', async () => {
    const res = await fetch(`${baseUrl}/v1/chatkit/threads/${TEST_THREAD_SEGMENT}`, {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.id).toBe(TEST_THREAD_ID);
    expect(json.object).toBe('chatkit.thread');
    expect(json.items.object).toBe('list');
    expect(json.items.data[0].object).toBe('chatkit.thread_item');
  });

  it('lists items at /v1/chatkit/threads/:id/items', async () => {
    const res = await fetch(`${baseUrl}/v1/chatkit/threads/${TEST_THREAD_SEGMENT}/items?limit=50`, {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.object).toBe('list');
    expect(json.data.length).toBeGreaterThanOrEqual(1);
    expect(json.data[0].object).toBe('chatkit.thread_item');
  });

  it('returns 400 for incomplete thread id', async () => {
    const res = await fetch(baseUrl + '/v1/chatkit/threads/thread_test_1', {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain('complete thread resource id is required');
  });
});
