import { beforeEach, describe, expect, it, vi } from 'vitest';
import { drizzle } from '@undefineds.co/drizzle-solid';
import { chatResource, messageResource, threadResource } from '@undefineds.co/models';
import { PodMatrixStore } from '../../../src/api/matrix';
import { MATRIX_TEST_SERVER_NAME, matrixHarness } from '../../helpers/MatrixMemoryDatabase';
import { InMemoryMatrixEventJournal, reservationKeyForEvent } from '../../../src/api/matrix/MatrixEventJournal';

vi.mock('@undefineds.co/drizzle-solid', async () => {
  const actual = await vi.importActual<typeof import('@undefineds.co/drizzle-solid')>('@undefineds.co/drizzle-solid');
  return { ...actual, drizzle: vi.fn() };
});

beforeEach(() => { vi.clearAllMocks(); });

describe('PodMatrixStore shared Pod contract', () => {
  it('rebuilds a reservation key from the stored event, so a lookup needs no index', async () => {
    const { context, db, rows } = matrixHarness();
    // A journal that records the key it was asked to reserve under — the same key a Pod carrier
    // would address the record by. A subclass, because spreading an instance copies no methods.
    class SpyJournal extends InMemoryMatrixEventJournal {
      public readonly keys: string[] = [];
      public override async reserveTransaction(
        scope: string,
        key: string,
        candidate: Parameters<InMemoryMatrixEventJournal['reserveTransaction']>[2],
      ): Promise<Parameters<InMemoryMatrixEventJournal['reserveTransaction']>[2]> {
        this.keys.push(key);
        return await super.reserveTransaction(scope, key, candidate);
      }
    }
    const journal = new SpyJournal();
    const keys = journal.keys;
    const store = new PodMatrixStore({ journal });
    const reader = { ...context, _matrixDb: db } as never;
    const room = await store.createRoom({}, context);
    const sent = await store.sendEvent(room.roomId, 'm.room.message', 'txn-key', { body: 'hi' }, reader);

    // What a later reader has: the stored row, nothing else.
    const stored = rows.get(messageResource)!
      .map((entry: any) => entry.metadata.protocols.matrix)
      .find((matrix: any) => matrix.event?.event_id === sent.eventId);
    expect(stored.txnId).toBe('txn-key');
    expect(reservationKeyForEvent({ roomId: room.roomId, type: stored.event.type, txnId: stored.txnId, txnDevice: stored.txnDevice }))
      .toBe(keys[0]);
    // An event with no reservation has no key rather than a wrong one.
    expect(reservationKeyForEvent({ roomId: room.roomId, type: 'm.room.message' })).toBeUndefined();
  });

  it('rebuilds a deterministic local order from the Pod alone', async () => {
    const { store, context, db } = matrixHarness();
    const room = await store.createRoom({}, context);
    for (const body of [ 'one', 'two', 'three' ]) {
      await store.sendEvent(room.roomId, 'm.room.message', `txn-${body}`, { body }, context);
    }
    const ordered = async(instance: PodMatrixStore, reader: typeof context): Promise<string[]> =>
      (await instance.sync(reader)).rooms.join[room.roomId].timeline.events.map(event => event.event_id);
    const first = await ordered(store, context);
    const bodies = (await store.sync(context)).rooms.join[room.roomId].timeline.events
      .map(event => (event.content as Record<string, unknown>).body)
      .filter((body): body is string => typeof body === 'string');
    expect(bodies).toEqual([ 'one', 'two', 'three' ]);

    // A deployment that lost its local journal (a wipe, a fresh node) reads the same Pod with a new
    // one. Two independent rebuilds have to agree: sequences are assigned in the order the Pod is
    // read — createdAt, then id — which is a function of the Pod and not of the table that was lost.
    const rebuilt = async(): Promise<string[]> => await ordered(
      new PodMatrixStore({ journal: new InMemoryMatrixEventJournal() }),
      { ...context, _matrixDb: db } as never,
    );
    expect(await rebuilt()).toEqual(await rebuilt());
    expect(new Set(await rebuilt())).toEqual(new Set(first));
    // What a rebuild cannot promise is the *arrival* order between events written in the same
    // millisecond: the tie is broken by id, which need not be the order they arrived in. That is
    // exactly why this sequence is a local accelerator and the client's cursor is the client's own
    // business (2026-09-27).
  });

  it('makes a newly granted agent a member, and does not re-write an existing one', async () => {
    const { store, context, rows } = matrixHarness();
    const room = await store.createRoom({}, context);
    const grant = (agent: string) => ({
      agent, executor: 'https://alice.example/card#me', workspace: 'https://pod.example/alice/',
      allowedActors: [ 'https://alice.example/card#me' ], handoffTo: [],
    });
    const members = (userId: string): Record<string, unknown>[] => rows.get(messageResource)!
      .map((row: any) => row.metadata.protocols.matrix.event)
      .filter((event: any) => event.type === 'm.room.member' && event.state_key === userId);

    const agent = 'https://pod.example/alice/.data/agents/scribe.ttl#this';
    const agentUserId = store.matrixUserIdFor(agent, MATRIX_TEST_SERVER_NAME);
    await store.setState(room.roomId, 'co.undefineds.agents', '', { agents: [ grant(agent) ] }, context);

    // Granting is what makes it a member: an invite by the granter, then the agent's own join.
    const events = members(agentUserId);
    expect(events.map((event: any) => event.content.membership)).toEqual([ 'invite', 'join' ]);
    expect(events[1].sender).toBe(agentUserId);
    expect(events[1].state_key).toBe(agentUserId);

    // Writing the same grant again appends no history: it was already a member.
    await store.setState(room.roomId, 'co.undefineds.agents', '', { agents: [ grant(agent) ] }, context);
    expect(members(agentUserId)).toHaveLength(2);

    // Revoking the grant does not remove the member (execution authority and protocol membership are
    // separate facts), so re-granting later must not invite somebody who is already in the room: the
    // room's own rules refuse that (v11-4.4.3), which is how this case was found.
    await store.setState(room.roomId, 'co.undefineds.agents', '', { agents: [] }, context);
    await store.setState(room.roomId, 'co.undefineds.agents', '', { agents: [ grant(agent) ] }, context);
    expect(members(agentUserId).map((event: any) => event.content.membership)).toEqual([ 'invite', 'join' ]);
  });

  it('names the event after the id its writer chose, and a replay lands on it', async () => {
    const { store, context } = matrixHarness();
    const room = await store.createRoom({}, context);

    // The writer names its own event. A retry carries the same name, so it is the same event — which
    // is what lets the reservation table go: the id, not a record, is what a replay matches on.
    const first = await store.sendEvent(room.roomId, 'm.room.message', 'txn-1', { body: 'hi' }, context, { msgid: '$writer-chosen' });
    const again = await store.sendEvent(room.roomId, 'm.room.message', 'txn-1', { body: 'hi' }, context, { msgid: '$writer-chosen' });
    expect(first.eventId).toBe('$writer-chosen');
    expect(again.eventId).toBe('$writer-chosen');

    // Without one, the deployment names it — and two sends are two events.
    const one = await store.sendEvent(room.roomId, 'm.room.message', 'txn-2', { body: 'a' }, context);
    const two = await store.sendEvent(room.roomId, 'm.room.message', 'txn-3', { body: 'b' }, context);
    expect(one.eventId).not.toBe(two.eventId);
  });

  it('writes the sending device onto the event, so the event alone names its reservation', async () => {
    const { store, context, rows } = matrixHarness();
    const room = await store.createRoom({}, context);
    const sent = await store.sendEvent(room.roomId, 'm.room.message', 'txn-42', { body: 'hi' }, context);

    const row = rows.get(messageResource)!
      .find((entry: any) => entry.metadata.protocols.matrix.event.event_id === sent.eventId);
    const matrix = row.metadata.protocols.matrix;
    expect(matrix.txnId).toBe('txn-42');
    // The reservation key is [device, roomId, type, txnId]; the event carries everything but the
    // device, so the device is what has to be stored. A quote-free token on purpose: this storage
    // corrupts a metadata string that contains quotes (contract §8).
    expect(matrix.txnDevice).toMatch(/^XPOD[0-9A-F]+$/u);
    expect(matrix.txnDevice).not.toContain('"');
    // It is bookkeeping, not protocol: the canonical event must not gain a field.
    expect(matrix.event.txnDevice).toBeUndefined();
  });

  it('creates federated rooms by default and records an explicit opt-out', async () => {
    const { store, context, rows } = matrixHarness();
    const createContent = async (creation_content?: Record<string, unknown>) => {
      const room = await store.createRoom(creation_content ? { creation_content } : {}, context);
      const event = rows.get(messageResource)!
        .map((row: any) => row.metadata.protocols.matrix.event)
        .find((stored: any) => stored?.type === 'm.room.create' && stored?.room_id === room.roomId)!;
      const chat = rows.get(chatResource)!.find((row: any) => row.metadata.protocols.matrix.roomId === room.roomId)!;
      return { event, federate: chat.metadata.protocols.matrix.federate };
    };

    // Absent means the room federates: the distributed target requires it.
    const implicit = await createContent();
    expect(implicit.event.content['m.federate']).toBeUndefined();
    expect(implicit.federate).toBe(true);

    const explicit = await createContent({ 'm.federate': true });
    expect(explicit.event.content['m.federate']).toBeUndefined();

    const optedOut = await createContent({ 'm.federate': false });
    expect(optedOut.event.content['m.federate']).toBe(false);
    expect(optedOut.federate).toBe(false);

    // Room version is still pinned: only the version this store validates is accepted.
    await expect(store.createRoom({ creation_content: { room_version: '10' } }, context))
      .rejects.toMatchObject({ status: 400, errcode: 'M_UNSUPPORTED_ROOM_VERSION' });
  });

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
    const invite = rows.get(messageResource)!.find((row) => row.metadata.protocols.matrix.event.state_key === '@bob:example.test');
    expect(invite.metadata).toMatchObject({ protocols: { matrix: { event: {
      type: 'm.room.member', state_key: '@bob:example.test', content: { membership: 'invite' },
    } } } });
    // The protocol fact lives under the event; the row itself must not mirror it.
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
    expect(await store.joinRoom(`#team:${MATRIX_TEST_SERVER_NAME}`, bob)).toEqual({ roomId: room.roomId });
    expect(await store.getState(room.roomId, 'm.room.member', bobId, bob)).toMatchObject({ membership: 'join' });
    expect(await store.listJoinedRooms(bob)).toContain(room.roomId);
    await expect(store.joinRoom(`#missing:${MATRIX_TEST_SERVER_NAME}`, context)).rejects.toMatchObject({ errcode: 'M_NOT_FOUND' });
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
    const store = new PodMatrixStore({ serverName: MATRIX_TEST_SERVER_NAME, podAccess: { getPodFetch } });
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
