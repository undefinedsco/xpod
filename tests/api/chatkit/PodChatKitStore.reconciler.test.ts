import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PodChatKitStore, type StoreContext, type UserMessageItem } from '../../../src/api/chatkit';

const { db } = vi.hoisted(() => ({
  db: createDb(),
}));

vi.mock('@undefineds.co/drizzle-solid', async () => {
  const actual = await vi.importActual<typeof import('@undefineds.co/drizzle-solid')>('@undefineds.co/drizzle-solid');
  return {
    ...actual,
    drizzle: vi.fn(() => db),
  };
});

function createDb(): any {
  return {
    init: vi.fn(async () => undefined),
    findByIri: vi.fn(async () => undefined),
    insert: vi.fn(() => ({
      values: vi.fn(async () => undefined),
    })),
    select: vi.fn(() => createSelectQuery([])),
  };
}

function createSelectQuery(result: unknown[]): any {
  const query: any = {
    from: vi.fn(() => Promise.resolve(result)),
  };
  return query;
}

function solidContext(): StoreContext {
  return {
    userId: 'https://alice.example/profile/card#me',
    auth: {
      type: 'solid',
      webId: 'https://alice.example/profile/card#me',
      accessToken: 'token',
      tokenType: 'Bearer',
    } as any,
  } as StoreContext;
}

describe('PodChatKitStore group Reconciler integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.findByIri.mockResolvedValue(undefined);
    db.select.mockReturnValue(createSelectQuery([]));
  });

  it('enqueues group Reconciler wake after ChatKit user messages', async () => {
    const serverGroupReconcilerService = {
      reconcileThreadMessage: vi.fn(async () => ({ wakeJobs: [], inserted: 0 })),
    };
    const store = new PodChatKitStore({
      tokenEndpoint: 'https://alice.example/.oidc/token',
      serverGroupReconcilerService: serverGroupReconcilerService as any,
    });
    const context = solidContext() as any;
    const threadId = 'chat/team/index.ttl#thread';
    const messageId = 'chat/team/2026/06/14/messages.ttl#msg_1';
    context._threadMetadataCache = new Map([[threadId, {
      id: threadId,
      status: { type: 'active' },
      reconcilerOwner: 'server',
      created_at: 1,
      updated_at: 1,
      metadata: {
        reconcilerOwner: 'server',
      },
    }]]);

    const item: UserMessageItem = {
      id: messageId,
      thread_id: threadId,
      created_at: 1_781_395_200,
      type: 'user_message',
      content: [{ type: 'input_text', text: '@secretary please summarize' }, { type: 'input_tag', tag: 'https://alice.example/.data/agents/secretary.ttl#this', label: 'secretary' }],
    };

    await store.addThreadItem({ thread_id: threadId, chat_id: 'team' }, item, context);

    const inserted = db.insert.mock.results
      .flatMap((result: any) => result.value.values.mock.calls.map((call: any[]) => call[0]));
    const message = inserted.find((value: any) => value.id === messageId);
    expect(message.metadata.chat_id).toBeUndefined();
    expect(message.metadata.protocols.chatkit).toEqual(expect.objectContaining({
      chat_id: 'team',
      thread_id: threadId,
      item_id: messageId,
    }));

    expect(serverGroupReconcilerService.reconcileThreadMessage).toHaveBeenCalledWith(expect.objectContaining({
      thread: 'https://alice.example/.data/chat/team/index.ttl#thread',
      triggerMessage: 'https://alice.example/.data/chat/team/2026/06/14/messages.ttl#msg_1',
      actor: 'https://alice.example/profile/card#me',
      role: 'user',
      content: '@secretary please summarize',
      reconcilerOwner: 'server',
      mentions: ['https://alice.example/.data/agents/secretary.ttl#this'],
    }));
  });

  it('loads thread metadata before routing when the request has no metadata cache', async () => {
    const serverGroupReconcilerService = {
      reconcileThreadMessage: vi.fn(async () => ({ wakeJobs: [], inserted: 0 })),
    };
    const store = new PodChatKitStore({
      tokenEndpoint: 'https://alice.example/.oidc/token',
      serverGroupReconcilerService: serverGroupReconcilerService as any,
    });
    const context = solidContext() as any;
    const threadId = 'chat/team/index.ttl#thread';
    const messageId = 'chat/team/2026/06/14/messages.ttl#msg_2';
    db.findByIri.mockResolvedValue({
      id: threadId,
      parent: '/.data/chat/team/index.ttl#this',
      title: 'Team',
      status: 'active',
      metadata: {
        commandKind: 'chat',
        surface_id: 'team',
        chat_id: 'team',
        reconcilerOwner: 'server',
      },
      createdAt: '2026-06-14T10:00:00.000Z',
      updatedAt: '2026-06-14T10:00:00.000Z',
    });

    const item: UserMessageItem = {
      id: messageId,
      thread_id: threadId,
      created_at: 1_781_395_201,
      type: 'user_message',
      content: [{ type: 'input_text', text: '@reviewer please check' }, { type: 'input_tag', tag: 'https://alice.example/.data/agents/reviewer.ttl#this', label: 'reviewer' }],
    };

    await store.addThreadItem({ thread_id: threadId, chat_id: 'team' }, item, context);

    expect(db.findByIri).toHaveBeenCalled();
    expect(serverGroupReconcilerService.reconcileThreadMessage).toHaveBeenCalledWith(expect.objectContaining({
      thread: 'https://alice.example/.data/chat/team/index.ttl#thread',
      triggerMessage: 'https://alice.example/.data/chat/team/2026/06/14/messages.ttl#msg_2',
      role: 'user',
      content: '@reviewer please check',
      reconcilerOwner: 'server',
      mentions: ['https://alice.example/.data/agents/reviewer.ttl#this'],
    }));
  });
});
