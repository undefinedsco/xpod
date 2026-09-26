import { describe, expect, it } from 'vitest';
import { messageResource, MessageRole } from '@undefineds.co/models';
import { matrixHarness } from '../../helpers/MatrixMemoryDatabase';
import { getProtocolMetadata, withProtocolMetadata } from '../../../src/api/protocol-metadata';
import { buildPersistedEvent } from '../../../src/api/matrix/persistedEvent';
import { resolveRoomState } from '../../../src/api/matrix/roomState';
import type { MatrixEventRecord } from '../../../src/api/matrix/types';

/** The fields of a stored protocol event these tests read. */
interface StoredProtocolEvent {
  event_id: string;
  type?: string;
  state_key?: string;
  sender?: string;
  depth?: number;
  auth_events?: string[];
}

/** The harness rows as the records `resolveRoomState` takes. */
function recordsOf(rows: Map<unknown, any[]>, roomId: string): MatrixEventRecord[] {
  return rows.get(messageResource as never)!.map((row: any) => {
    const event = getProtocolMetadata(row.metadata, 'matrix')?.event as Record<string, unknown> | undefined;
    return {
      eventId: String(event?.event_id ?? row.id),
      roomId,
      type: String(event?.type ?? 'm.room.message'),
      sender: String(event?.sender ?? '@unknown:example.test'),
      senderWebId: row.maker,
      originServerTs: Number(event?.origin_server_ts ?? 0),
      depth: Number(event?.depth ?? 0),
      role: row.role,
      resourceId: row.id,
      createdAt: row.createdAt,
      content: (event?.content ?? {}) as Record<string, unknown>,
      ...(event?.state_key === undefined ? {} : { stateKey: String(event.state_key) }),
      ...(event === undefined ? {} : { event }),
    };
  });
}

/**
 * The harness keeps rows in a plain array, so a fork — two writers attaching to the
 * same parent — can be created exactly as a second deployment's copy would arrive.
 */
function appendProtocolEvent(rows: Map<unknown, any[]>, event: Record<string, unknown>, input: {
  maker: string; createdAt: string; role?: string;
}): void {
  const exemplar = rows.get(messageResource as never)![0];
  rows.get(messageResource as never)!.push({
    ...structuredClone(exemplar),
    id: `chat/fork/${String(event.event_id)}`,
    maker: input.maker,
    role: input.role ?? MessageRole.USER,
    content: 'forked',
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    metadata: withProtocolMetadata({}, 'matrix', { event }),
  });
}

async function joinedRoom() {
  const { store, context, rows } = matrixHarness();
  const room = await store.createRoom({}, context);
  const alice = (await store.getAccount(context)).userId;
  const bobContext = { ...context, webId: 'https://bob.example/profile/card#me' };
  const bob = (await store.getAccount(bobContext)).userId;
  await store.inviteUser(room.roomId, bob, context);
  await store.joinRoom(room.roomId, bobContext);
  const events = rows.get(messageResource as never)!;
  const eventOf = (type: string, stateKey = ''): StoredProtocolEvent | undefined => events
    .map((row: any) => getProtocolMetadata(row.metadata, 'matrix')?.event as StoredProtocolEvent | undefined)
    .find(event => event?.type === type && event?.state_key === stateKey);
  return { store, context, rows, room, alice, bob, bobContext, eventOf };
}

describe('resolved room state', () => {
  it('matches the state a linear room has, slot by slot', async () => {
    const { store, context, room, alice, bob } = await joinedRoom();
    const state = await store.currentState(room.roomId, context);

    expect(state.get('m.room.create')?.sender).toBe(alice);
    expect(state.get('m.room.member', alice)?.content.membership).toBe('join');
    expect(state.get('m.room.member', bob)?.content.membership).toBe('join');
    expect(state.membership(alice)).toBe('join');
    expect(state.membership('@nobody:example.test')).toBeUndefined();
    // A linearly written room resolves to the same slots the old rule would pick.
    expect([ ...state.entries() ].map(([ key ]) => key).sort())
      .toEqual([ 'm.room.create|', `m.room.member|${alice}`, `m.room.member|${bob}` ].sort());
  });

  it('keeps a member slot for someone who was invited and never joined', async () => {
    const { store, context, room } = await joinedRoom();
    const carol = '@u_carol:example.test';
    await store.inviteUser(room.roomId, carol, context);
    const state = await store.currentState(room.roomId, context);
    expect(state.membership(carol)).toBe('invite');
  });

  it('falls back to the latest event per slot for rows written before the graph', async () => {
    const events = [
      { eventId: '$old_a', roomId: '!r:example.test', type: 'm.room.member', sender: '@a:example.test',
        senderWebId: 'https://a.example/#me', originServerTs: 1, depth: 1, role: MessageRole.USER,
        stateKey: '@b:example.test', content: { membership: 'invite' }, resourceId: 'a', createdAt: 'x' },
      { eventId: '$old_b', roomId: '!r:example.test', type: 'm.room.member', sender: '@a:example.test',
        senderWebId: 'https://a.example/#me', originServerTs: 2, depth: 2, role: MessageRole.USER,
        stateKey: '@b:example.test', content: { membership: 'join' }, resourceId: 'b', createdAt: 'y' },
    ] as never[];
    const state = resolveRoomState(events);
    expect(state.membership('@b:example.test')).toBe('join');
    // Without graph fields a "state" is still produced, just not a resolved one.
    expect(state.size).toBe(1);
  });

  it('resolves a fork to the ban even when the later event is a rejoin', async () => {
    const { store, context, rows, room, alice, bob, bobContext, eventOf } = await joinedRoom();
    const joinedAt = eventOf('m.room.member', bob)!;
    const create = eventOf('m.room.create')!;
    const aliceJoin = eventOf('m.room.member', alice)!;
    const authEvents = [ create.event_id, aliceJoin.event_id, joinedAt.event_id ];
    const base = { roomId: room.roomId, prevEvents: [ joinedAt.event_id ], authEvents };

    // Branch one: ALICE bans BOB.
    const ban = buildPersistedEvent({
      ...base, type: 'm.room.member', sender: alice, stateKey: bob, originServerTs: 1_000,
      content: { membership: 'ban' }, depth: (joinedAt.depth ?? 0) + 1,
    });
    // Branch two, written later so a local-order read would call it the current state:
    // BOB joins again.
    const rejoin = buildPersistedEvent({
      ...base, type: 'm.room.member', sender: bob, stateKey: bob, originServerTs: 2_000,
      content: { membership: 'join' }, depth: (joinedAt.depth ?? 0) + 1,
    });
    appendProtocolEvent(rows, ban, { maker: context.webId, createdAt: '2026-09-27T00:00:01.000Z' });
    appendProtocolEvent(rows, rejoin, { maker: bobContext.webId, createdAt: '2026-09-27T00:00:02.000Z' });

    // The replay sees the rejoin last, yet the resolved state is the ban: the ban is a
    // power event, so it is applied first and the rejoin is refused against it.
    const state = await store.currentState(room.roomId, context);
    expect(state.membership(bob)).toBe('ban');

    // And the write path agrees: a banned member cannot send.
    await expect(store.sendEvent(room.roomId, 'm.room.message', 'banned', { body: 'hi' }, bobContext))
      .rejects.toMatchObject({ status: 403 });

    // getMembers reports the resolved membership too.
    const members = await store.getMembers(room.roomId, context);
    expect(members.find(event => event.state_key === bob)?.content.membership).toBe('ban');
  });

  it('is independent of the order the events are given in', async () => {
    const { store, context, rows, room, alice, bob, eventOf } = await joinedRoom();
    const joinedAt = eventOf('m.room.member', bob)!;
    const create = eventOf('m.room.create')!;
    const authEvents = [ create.event_id, eventOf('m.room.member', alice)!.event_id, joinedAt.event_id ];
    appendProtocolEvent(rows, buildPersistedEvent({
      roomId: room.roomId, type: 'm.room.member', sender: alice, stateKey: bob, originServerTs: 1_000,
      content: { membership: 'ban' }, prevEvents: [ joinedAt.event_id ], authEvents,
    }), { maker: context.webId, createdAt: '2026-09-27T00:00:01.000Z' });
    appendProtocolEvent(rows, buildPersistedEvent({
      roomId: room.roomId, type: 'm.room.member', sender: bob, stateKey: bob, originServerTs: 2_000,
      content: { membership: 'leave' }, prevEvents: [ joinedAt.event_id ], authEvents,
    }), { maker: 'https://bob.example/profile/card#me', createdAt: '2026-09-27T00:00:02.000Z' });

    const records = recordsOf(rows, room.roomId);
    expect((await store.currentState(room.roomId, context)).membership(bob)).toBe('ban');
    expect(resolveRoomState(records).membership(bob)).toBe('ban');
    expect(resolveRoomState([ ...records ].reverse()).membership(bob)).toBe('ban');
  });

  it('does not throw on an event whose parent is missing', async () => {
    const { store, context, rows, room, alice, bob, eventOf } = await joinedRoom();
    const create = eventOf('m.room.create')!;
    const orphan = buildPersistedEvent({
      roomId: room.roomId, type: 'm.room.topic', sender: alice, stateKey: '', originServerTs: 3_000,
      content: { topic: 'orphan' }, prevEvents: [ '$missing_parent' ],
      authEvents: [ create.event_id, eventOf('m.room.member', alice)!.event_id ],
    });
    appendProtocolEvent(rows, orphan, { maker: context.webId, createdAt: '2026-09-27T00:00:03.000Z' });
    const state = await store.currentState(room.roomId, context);
    expect(state.get('m.room.topic')?.content.topic).toBe('orphan');
    // The rest of the state is still there.
    expect(state.membership(bob)).toBe('join');
  });
});
