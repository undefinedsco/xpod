import { describe, expect, it } from 'vitest';
import { PodChatKitStore } from '../../src/api/chatkit/pod-store';
import type { StoreContext } from '../../src/api/chatkit/store';
import type { UserMessageItem } from '../../src/api/chatkit/types';

function createInsertRecorder() {
  const records: Array<Record<string, unknown>> = [];
  return {
    records,
    db: {
      insert: () => ({
        values: async (record: Record<string, unknown>) => {
          records.push(record);
        },
      }),
    },
  };
}

function createContext(db: unknown): StoreContext {
  return {
    userId: 'https://pod.example/profile/card#me',
    auth: undefined,
    _cachedDb: db,
    _cachedPodBaseUrl: 'https://pod.example',
  } as StoreContext;
}

function userMessage(id: string, threadId: string): UserMessageItem {
  return {
    id,
    thread_id: threadId,
    type: 'user_message',
    created_at: Date.UTC(2026, 5, 16, 0, 0, 0) / 1000,
    content: [{ type: 'input_text', text: 'hello' }],
  };
}

describe('PodChatKitStore Message parent', () => {
  it('writes Chat messages with the Chat command surface as parent', async () => {
    const { db, records } = createInsertRecorder();
    const store = new PodChatKitStore({ tokenEndpoint: 'https://issuer.example/token' });
    const threadId = 'chat/default/index.ttl#thread-1';

    await store.addThreadItem(
      { thread_id: threadId },
      userMessage('chat/default/2026/06/16/messages.ttl#msg-1', threadId),
      createContext(db),
    );

    expect(records[0]).toMatchObject({
      parent: 'https://pod.example/.data/chat/default/index.ttl#this',
      chat: 'default/index.ttl#this',
      thread: 'https://pod.example/.data/chat/default/index.ttl#thread-1',
    });
  });

  it('writes Task messages with the Task command surface as parent even when no Chat relation exists', async () => {
    const { db, records } = createInsertRecorder();
    const store = new PodChatKitStore({ tokenEndpoint: 'https://issuer.example/token' });
    const threadId = 'task/task_1/index.ttl#worker-thread-1';

    await store.addThreadItem(
      { thread_id: threadId },
      userMessage('task/task_1/2026/06/16/messages.ttl#msg-1', threadId),
      createContext(db),
    );

    expect(records[0]).toMatchObject({
      parent: 'https://pod.example/.data/task/index.ttl#task_1',
      chat: null,
      thread: 'https://pod.example/.data/task/task_1/index.ttl#worker-thread-1',
    });
  });
});
