import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { drizzle } from '@undefineds.co/drizzle-solid';
import { PodMatrixStore } from '../../../src/api/matrix';

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
    findById: vi.fn(async () => ({ id: 'rooms/~21room~3Aexample.com/index.ttl#this' })),
    insert: vi.fn(() => ({
      values: vi.fn(async () => undefined),
    })),
    select: vi.fn(() => createSelectQuery([])),
  };
}

function createSelectQuery(result: unknown[]): any {
  const query: any = {
    from: vi.fn(() => query),
    where: vi.fn(() => query),
    orderBy: vi.fn(() => query),
    limit: vi.fn(() => Promise.resolve(result)),
    then: (resolve: (value: unknown[]) => unknown, reject?: (reason: unknown) => unknown) => (
      Promise.resolve(result).then(resolve, reject)
    ),
  };
  return query;
}

function solidContext() {
  return {
    webId: 'https://alice.example/profile/card#me',
    auth: {
      type: 'solid',
      webId: 'https://alice.example/profile/card#me',
      accessToken: 'token',
      tokenType: 'Bearer',
    } as any,
  };
}

function flattenExpressions(condition: any): any[] {
  if (!condition) {
    return [];
  }
  if (Array.isArray(condition.expressions)) {
    return condition.expressions.flatMap(flattenExpressions);
  }
  return [condition];
}

describe('PodMatrixStore query pushdown', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('derives a stable Matrix account from the Solid auth context', async () => {
    const store = new PodMatrixStore({ serverName: 'example.com' });

    const account = await store.getAccount(solidContext());

    expect(account.userId).toBe('@profile_card_me:example.com');
    expect(account.deviceId).toMatch(/^XPOD[A-F0-9]{12}$/u);
    expect(account.displayName).toBe('profile_card_me');
  });

  it('opens drizzle-solid against the current SP Pod URL when provided', async () => {
    const store = new PodMatrixStore({ serverName: 'example.com' });

    await store.createRoom({ name: 'Local room' }, {
      ...solidContext(),
      podUrl: 'https://node-0000.undefineds.co/alice/',
    });

    expect(drizzle).toHaveBeenCalledWith(
      expect.objectContaining({
        info: expect.objectContaining({
          webId: 'https://alice.example/profile/card#me',
          podUrl: 'https://node-0000.undefineds.co/alice/',
        }),
      }),
      expect.objectContaining({
        podUrl: 'https://node-0000.undefineds.co/alice/',
      }),
    );
  });

  it('records invites as Matrix membership events while storing data in chat resources', async () => {
    const store = new PodMatrixStore({ serverName: 'example.com' });

    await store.createRoom({
      room_alias_name: 'team',
      name: 'Team',
      invite: ['@bob:example.com'],
    }, solidContext());

    const inserted = db.insert.mock.results
      .flatMap((result: any) => result.value.values.mock.calls.map((call: any[]) => call[0]));
    expect(inserted.some((value: any) => String(value.id).startsWith('matrix-') && value.metadata?.protocol === 'matrix')).toBe(true);
    expect(inserted.every((value: any) => !String(value.id).startsWith('matrix/'))).toBe(true);
    const matrixMetadata = inserted
      .map((value: any) => value.metadata)
      .find((metadata: any) => metadata?.protocol === 'matrix' && metadata.protocols?.matrix?.roomId);
    expect(matrixMetadata.roomId).toBeUndefined();
    expect(matrixMetadata.protocols.matrix.roomId).toMatch(/^!/);
    expect(inserted).toEqual(expect.arrayContaining([
      expect.objectContaining({
        metadata: expect.objectContaining({
          protocol: 'matrix',
          reconcilerOwner: 'server',
        }),
      }),
    ]));
    const membershipMetadata = inserted
      .map((value: any) => value.metadata)
      .find((metadata: any) => metadata?.protocols?.matrix?.eventType === 'm.room.member' && metadata.protocols.matrix.stateKey === '@bob:example.com');
    expect(membershipMetadata.eventType).toBeUndefined();
    expect(membershipMetadata.stateKey).toBeUndefined();
    expect(inserted).toEqual(expect.arrayContaining([
      expect.objectContaining({
        metadata: expect.objectContaining({
          protocols: expect.objectContaining({
            matrix: expect.objectContaining({
              eventType: 'm.room.member',
              stateKey: '@bob:example.com',
              content: expect.objectContaining({ membership: 'invite' }),
            }),
          }),
        }),
      }),
    ]));
  });

  it('ignores Matrix is_direct hints instead of storing Xpod topology', async () => {
    const store = new PodMatrixStore({ serverName: 'example.com' });

    const room = await store.createRoom({
      is_direct: true,
      invite: ['@bob:example.com'],
    } as any, solidContext());

    expect(room.reconcilerOwner).toBe('server');
    const inserted = db.insert.mock.results
      .flatMap((result: any) => result.value.values.mock.calls.map((call: any[]) => call[0]));
    expect(inserted).toEqual(expect.arrayContaining([
      expect.objectContaining({
        metadata: expect.objectContaining({
          protocol: 'matrix',
          reconcilerOwner: 'server',
        }),
      }),
    ]));
    expect(inserted.some((value: any) => value.metadata?.protocols?.matrix?.is_direct !== undefined)).toBe(false);
  });

  it('projects owner-only coordination metadata through Matrix sync', async () => {
    const store = new PodMatrixStore({ serverName: 'example.com' });
    db.select
      .mockReturnValueOnce(createSelectQuery([{
        id: 'matrix-room/index.ttl#this',
        title: 'DM',
        author: 'https://alice.example/profile/card#me',
        createdAt: '1970-01-01T00:00:00.001Z',
        metadata: {
          protocol: 'matrix',
          reconcilerOwner: 'server',
          protocols: {
            matrix: {
              roomId: '!dm:example.com',
            },
          },
        },
      }]))
      .mockReturnValueOnce(createSelectQuery([]))
      .mockReturnValueOnce(createSelectQuery([]));

    const sync = await store.sync(solidContext());

    expect(sync.rooms.join['!dm:example.com']['co.undefineds.coordination']).toEqual({
      reconcilerOwner: 'server',
    });
  });

  it('keeps RDF-hydrated array protocol metadata visible to joined room listing', async () => {
    const store = new PodMatrixStore({ serverName: 'example.com' });
    db.select
      .mockReturnValueOnce(createSelectQuery([{
        id: 'matrix-room/index.ttl#this',
        title: 'Array Room',
        author: 'https://alice.example/profile/card#me',
        createdAt: '1970-01-01T00:00:00.001Z',
        metadata: {
          protocol: 'matrix',
          protocols: [
            {
              matrix: {
                roomId: '!array:example.com',
              },
            },
            {
              matrix: {
                visibility: 'private',
              },
            },
          ],
        },
      }]))
      .mockReturnValueOnce(createSelectQuery([]));

    await expect(store.listJoinedRooms(solidContext())).resolves.toEqual(['!array:example.com']);
  });

  it('resolves canonical aliases and appends join membership events', async () => {
    const store = new PodMatrixStore({ serverName: 'example.com' });
    db.select
      .mockReturnValueOnce(createSelectQuery([{
        id: 'matrix-room/index.ttl#this',
        title: 'Team',
        author: 'https://alice.example/profile/card#me',
        createdAt: '1970-01-01T00:00:00.001Z',
        metadata: {
          protocol: 'matrix',
          protocols: {
            matrix: {
              roomId: '!room:example.com',
              canonicalAlias: '#team:example.com',
            },
          },
        },
      }]))
      .mockReturnValueOnce(createSelectQuery([]))
      .mockReturnValueOnce(createSelectQuery([]));

    const result = await store.joinRoom('#team:example.com', solidContext());

    expect(result).toEqual({ roomId: '!room:example.com' });
    const inserted = db.insert.mock.results
      .flatMap((callResult: any) => callResult.value.values.mock.calls.map((call: any[]) => call[0]));
    expect(inserted).toEqual(expect.arrayContaining([
      expect.objectContaining({
        metadata: expect.objectContaining({
          protocols: expect.objectContaining({
            matrix: expect.objectContaining({
              eventType: 'm.room.member',
              stateKey: '@profile_card_me:example.com',
              content: expect.objectContaining({ membership: 'join' }),
            }),
          }),
        }),
      }),
    ]));
  });

  it('pushes Matrix message pagination direction into drizzle-solid predicates', async () => {
    const store = new PodMatrixStore({});

    const backwardQuery = createSelectQuery([]);
    db.select.mockReturnValueOnce(backwardQuery);
    await store.listMessages('!room:example.com', solidContext(), {
      from: 's200',
      dir: 'b',
      limit: 10,
    });

    const backwardConditions = flattenExpressions(backwardQuery.where.mock.calls[0][0]);
    expect(backwardConditions).toEqual(expect.arrayContaining([
      expect.objectContaining({ operator: '=', right: threadResourceUri('!room:example.com') }),
      expect.objectContaining({ operator: '<=', right: '1970-01-01T00:00:00.200Z' }),
    ]));
    expect(backwardConditions).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ operator: '>', right: '1970-01-01T00:00:00.200Z' }),
    ]));
    expect(backwardQuery.orderBy.mock.calls[0][0]).toMatchObject({ direction: 'desc' });
    expect(backwardQuery.limit).toHaveBeenCalledWith(10);

    const forwardQuery = createSelectQuery([]);
    db.select.mockReturnValueOnce(forwardQuery);
    await store.listMessages('!room:example.com', solidContext(), {
      from: 's200',
      dir: 'f',
      limit: 10,
    });

    const forwardConditions = flattenExpressions(forwardQuery.where.mock.calls[0][0]);
    expect(forwardConditions).toEqual(expect.arrayContaining([
      expect.objectContaining({ operator: '=', right: threadResourceUri('!room:example.com') }),
      expect.objectContaining({ operator: '>', right: '1970-01-01T00:00:00.200Z' }),
    ]));
    expect(forwardConditions).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ operator: '<=', right: '1970-01-01T00:00:00.200Z' }),
    ]));
    expect(forwardQuery.orderBy.mock.calls[0][0]).toMatchObject({
      column: expect.objectContaining({ name: 'createdAt' }),
      direction: 'asc',
    });
    expect(forwardQuery.limit).toHaveBeenCalledWith(10);
  });

  it('computes new event depth from the current room max depth only', async () => {
    const store = new PodMatrixStore({});
    const txnQuery = createSelectQuery([]);
    const depthQuery = createSelectQuery([{
      id: 'chat/matrix-room/2026/05/18/messages.ttl#old',
      createdAt: '1970-01-01T00:00:00.041Z',
      metadata: {
        protocol: 'matrix',
        eventId: '$old:example.com',
        roomId: '!room:example.com',
        eventType: 'm.room.message',
        sender: '@alice:example.com',
        originServerTs: 41,
        depth: 41,
        content: { body: 'old' },
      },
    }]);
    db.select.mockReturnValueOnce(txnQuery).mockReturnValueOnce(depthQuery);

    const event = await store.sendEvent('!room:example.com', 'm.room.message', 'txn-1', {
      msgtype: 'm.text',
      body: 'hello',
    }, solidContext());

    expect(event.eventId).toMatch(/^\$/);
    expect(event.depth).toBe(42);
    expect(flattenExpressions(depthQuery.where.mock.calls[0][0])).toEqual(expect.arrayContaining([
      expect.objectContaining({ operator: '=', right: threadResourceUri('!room:example.com') }),
    ]));
    expect(depthQuery.orderBy.mock.calls[0][0]).toMatchObject({
      column: expect.objectContaining({ name: 'createdAt' }),
      direction: 'asc',
    });
    expect(db.insert).toHaveBeenCalled();
  });

  it('enqueues group Reconciler wake after Matrix user messages', async () => {
    const serverGroupReconcilerService = {
      reconcileThreadMessage: vi.fn(async () => ({ wakeJobs: [], inserted: 0 })),
    };
    const store = new PodMatrixStore({
      serverName: 'example.com',
      serverGroupReconcilerService: serverGroupReconcilerService as any,
    });
    db.findById.mockResolvedValue({
      id: 'rooms/~21room~3Aexample.com/index.ttl#this',
      metadata: {
        protocol: 'matrix',
        roomId: '!room:example.com',
        reconcilerOwner: 'server',
      },
    });
    db.select.mockReturnValue(createSelectQuery([]));

    await store.sendEvent('!room:example.com', 'm.room.message', 'txn-wake', {
      msgtype: 'm.text',
      body: '@secretary please summarize',
      mentions: ['https://alice.example/.data/agents/secretary.ttl#this'],
    }, solidContext());

    expect(serverGroupReconcilerService.reconcileThreadMessage).toHaveBeenCalledWith(expect.objectContaining({
      thread: threadResourceUri('!room:example.com'),
      actor: 'https://alice.example/profile/card#me',
      role: 'user',
      content: '@secretary please summarize',
      reconcilerOwner: 'server',
      mentions: ['https://alice.example/.data/agents/secretary.ttl#this'],
    }));
    expect(serverGroupReconcilerService.reconcileThreadMessage.mock.calls[0][0].triggerMessage)
      .toContain(`/.data/chat/${surfaceId('!room:example.com')}/`);
  });
});

function surfaceId(roomId: string): string {
  return `matrix-${createHash('sha256').update(roomId).digest('hex').slice(0, 16)}`;
}

function threadResourceUri(roomId: string): string {
  return `https://alice.example/.data/chat/${surfaceId(roomId)}/index.ttl#thread`;
}
