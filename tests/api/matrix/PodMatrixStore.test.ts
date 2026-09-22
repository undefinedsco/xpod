import { beforeEach, describe, expect, it, vi } from 'vitest';
import { drizzle } from '@undefineds.co/drizzle-solid';
import { chatResource, messageResource, threadResource } from '@undefineds.co/models';
import { PodMatrixStore } from '../../../src/api/matrix';
import { matrixHarness } from '../../helpers/MatrixMemoryDatabase';

vi.mock('@undefineds.co/drizzle-solid', async () => {
  const actual = await vi.importActual<typeof import('@undefineds.co/drizzle-solid')>('@undefineds.co/drizzle-solid');
  return { ...actual, drizzle: vi.fn() };
});

beforeEach(() => vi.clearAllMocks());

describe('PodMatrixStore shared Pod contract', () => {
  it('stores room, thread and event relationships using the shared models resources', async () => {
    const { store, context, rows } = matrixHarness();
    const room = await store.createRoom({ name: 'Team' }, context);
    await store.sendEvent(room.roomId, 'm.room.message', 'hello', { body: 'hello' }, context);
    const chat = rows.get(chatResource)![0];
    const thread = rows.get(threadResource)![0];
    const message = rows.get(messageResource)!.find((row) => row.content === 'hello');
    expect([...rows.keys()]).toEqual(expect.arrayContaining([chatResource, threadResource, messageResource]));
    expect(thread.parent).toBe(chatResource.buildIri(context.podUrl, { id: chat.id }));
    expect(message.thread).toBe(threadResource.buildIri(context.podUrl, { id: thread.id }));
    expect(message.parent).toBe(thread.parent);
    expect(message.maker).toBe(context.webId);
    expect(message.role).toBe('user');
  });

  it('keeps Matrix room and membership metadata namespaced and invites separate from joins', async () => {
    const { store, context, rows } = matrixHarness();
    const room = await store.createRoom({ room_alias_name: 'team', invite: ['@bob:example.test'] }, context);
    const metadata = rows.get(chatResource)![0].metadata;
    expect(metadata).toMatchObject({ protocol: 'matrix', reconcilerOwner: 'server', protocols: { matrix: { roomId: room.roomId } } });
    expect(metadata.roomId).toBeUndefined();
    const invite = rows.get(messageResource)!.find((row) => row.metadata.protocols.matrix.stateKey === '@bob:example.test');
    expect(invite.metadata).toMatchObject({ protocols: { matrix: {
      eventType: 'm.room.member', stateKey: '@bob:example.test', content: { membership: 'invite' },
    } } });
    expect(invite.metadata.eventType).toBeUndefined();
    expect(invite.metadata.stateKey).toBeUndefined();
    const sync = await store.sync(context);
    expect(sync.rooms.join[room.roomId]['co.undefineds.coordination']).toEqual({ reconcilerOwner: 'server' });
  });

  it('ignores the Matrix direct-message hint as a coordination topology', async () => {
    const { store, context, rows } = matrixHarness();
    const room = await store.createRoom({ is_direct: true } as any, context);
    expect(room.reconcilerOwner).toBe('server');
    expect(rows.get(chatResource)![0].metadata.protocols.matrix.is_direct).toBeUndefined();
  });

  it.each(['legacy', 'RDF array'])('reads %s room metadata with owner-only membership fallback', async (format) => {
    const { store, context, rows } = matrixHarness();
    const room = await store.createRoom({}, context);
    const chat = rows.get(chatResource)![0];
    chat.metadata = format === 'legacy'
      ? { protocol: 'matrix', roomId: room.roomId, reconcilerOwner: 'server' }
      : { protocol: 'matrix', protocols: [{ matrix: { roomId: room.roomId } }, { matrix: { visibility: 'private' } }] };
    rows.set(messageResource, []);
    expect(await store.listJoinedRooms(context)).toContain(room.roomId);
    expect(await store.listJoinedRooms({ ...context, webId: 'https://bob.example/profile/card#me' })).not.toContain(room.roomId);
  });

  it('resolves the canonical alias for an invited participant', async () => {
    const { store, context } = matrixHarness();
    const bob = { ...context, webId: 'https://bob.example/profile/card#me' };
    const bobId = (await store.getAccount(bob)).userId;
    const room = await store.createRoom({ room_alias_name: 'team', invite: [bobId] }, context);
    expect(await store.joinRoom('#team:example.test', bob)).toEqual({ roomId: room.roomId });
    expect(await store.getState(room.roomId, 'm.room.member', bobId, bob)).toMatchObject({ membership: 'join' });
    expect(await store.listJoinedRooms(bob)).toContain(room.roomId);
    await expect(store.joinRoom('#missing:example.test', context)).rejects.toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it.each(['m.room.create', 'm.room.member', 'm.room.encryption'])('rejects unsupported initial %s state without writing a partial room', async (type) => {
    const { store, context, rows } = matrixHarness();
    await expect(store.createRoom({ initial_state: [{ type, content: {} }] }, context)).rejects.toThrow('Unsupported initial state event');
    expect(rows.size).toBe(0);
  });
});

describe('PodMatrixStore owner Pod access', () => {
  it('uses the delegated authenticated Pod fetch and selected Pod URL for drizzle', async () => {
    const { context: cachedContext, db } = matrixHarness();
    const { _matrixDb: _cachedDb, ...context } = cachedContext;
    const podFetch = vi.fn(async () => new Response());
    const getPodFetch = vi.fn(async () => podFetch);
    vi.mocked(drizzle).mockReturnValue(db);
    const store = new PodMatrixStore({ serverName: 'example.test', podAccess: { getPodFetch } });
    await store.createRoom({ name: 'Delegated room' }, context);
    expect(getPodFetch).toHaveBeenCalledWith(context.webId, { auth: context.auth, podBaseUrl: context.podUrl });
    expect(drizzle).toHaveBeenCalledWith(
      expect.objectContaining({ fetch: podFetch, info: expect.objectContaining({ webId: context.webId, podUrl: context.podUrl, isLoggedIn: true }) }),
      expect.objectContaining({ podUrl: context.podUrl, schema: expect.objectContaining({ chat: chatResource, thread: threadResource, message: messageResource }) }),
    );
  });

  it('denies storage access without an owner Pod grant', async () => {
    const { context: cachedContext } = matrixHarness();
    const { _matrixDb: _cachedDb, ...context } = cachedContext;
    const store = new PodMatrixStore({ podAccess: { getPodFetch: async () => undefined } });
    await expect(store.createRoom({}, context)).rejects.toThrow('Grant Pod interface access');
    expect(drizzle).not.toHaveBeenCalled();
  });
});
