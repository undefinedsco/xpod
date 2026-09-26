import { describe, expect, it } from 'vitest';
import { MatrixRoomStateReplay, resolveRoomState } from '../../../src/api/matrix/roomState';
import type { MatrixEventRecord } from '../../../src/api/matrix/types';

const ROOM = '!r:alice.example';
const ALICE = '@u_alice:alice.example';
const BOB = '@u_bob:bob.example';

/** A stored event as the room reader sees it. */
function record(event: Record<string, unknown>, depth: number): MatrixEventRecord {
  return {
    eventId: String(event.event_id),
    roomId: ROOM,
    type: String(event.type),
    sender: String(event.sender),
    senderWebId: 'https://alice.example/profile/card#me',
    originServerTs: Number(event.origin_server_ts ?? 0),
    depth,
    role: 'user',
    resourceId: String(event.event_id),
    content: (event.content ?? {}) as Record<string, unknown>,
    ...(event.state_key === undefined ? {} : { stateKey: String(event.state_key) }),
    event,
  };
}

const CREATE = { event_id: '$create', room_id: ROOM, type: 'm.room.create', state_key: '', sender: ALICE,
  origin_server_ts: 1, prev_events: [], auth_events: [], content: { room_version: '11' } };
const ALICE_JOIN = { event_id: '$alice_join', room_id: ROOM, type: 'm.room.member', state_key: ALICE, sender: ALICE,
  origin_server_ts: 2, prev_events: [ '$create' ], auth_events: [ '$create' ], content: { membership: 'join' } };
const BOB_INVITE = { event_id: '$bob_invite', room_id: ROOM, type: 'm.room.member', state_key: BOB, sender: ALICE,
  origin_server_ts: 3, prev_events: [ '$alice_join' ], auth_events: [ '$create', '$alice_join' ],
  content: { membership: 'invite' } };
const BOB_JOIN = { event_id: '$bob_join', room_id: ROOM, type: 'm.room.member', state_key: BOB, sender: BOB,
  origin_server_ts: 4, prev_events: [ '$bob_invite' ], auth_events: [ '$create', '$bob_invite' ],
  content: { membership: 'join' } };
const BOB_BAN = { event_id: '$bob_ban', room_id: ROOM, type: 'm.room.member', state_key: BOB, sender: ALICE,
  origin_server_ts: 5, prev_events: [ '$bob_join' ], auth_events: [ '$create', '$alice_join', '$bob_join' ],
  content: { membership: 'ban' } };
const BOB_LEAVE = { event_id: '$bob_leave', room_id: ROOM, type: 'm.room.member', state_key: BOB, sender: BOB,
  origin_server_ts: 6, prev_events: [ '$bob_join' ], auth_events: [ '$create', '$bob_join' ],
  content: { membership: 'leave' } };

const BASE = [ record(CREATE, 1), record(ALICE_JOIN, 2), record(BOB_INVITE, 3), record(BOB_JOIN, 4) ];

describe('incremental room replay', () => {
  it('extends with an appended state event and reflects it', () => {
    const replay = MatrixRoomStateReplay.from(BASE);
    expect(replay.state.membership(BOB)).toBe('join');

    const topic = record({ event_id: '$topic', room_id: ROOM, type: 'm.room.topic', state_key: '', sender: ALICE,
      origin_server_ts: 7, prev_events: [ '$bob_join' ], auth_events: [ '$create', '$alice_join' ],
      content: { topic: 'extended' } }, 5);
    const extended = replay.extend([ ...BASE, topic ]);
    expect(extended).toBeDefined();
    expect(extended!.state.get('m.room.topic')?.content.topic).toBe('extended');
    // The extension agrees with a full replay of the same list.
    expect([ ...extended!.state.entries() ].map(([ key ]) => key).sort())
      .toEqual([ ...resolveRoomState([ ...BASE, topic ]).entries() ].map(([ key ]) => key).sort());
    // The original replay is untouched.
    expect(replay.state.get('m.room.topic')).toBeUndefined();
  });

  it('returns the same replay when the list did not grow', () => {
    const replay = MatrixRoomStateReplay.from(BASE);
    expect(replay.extend(BASE)).toBe(replay);
    expect(replay.extend([ ...BASE ])).toBe(replay);
  });

  it('refuses a backfill whose parent is no longer an extremity', () => {
    const replay = MatrixRoomStateReplay.from(BASE);
    // `$bob_invite` has a child now, so an event hanging off it cannot be absorbed.
    const backfill = record({ event_id: '$late', room_id: ROOM, type: 'm.room.member', state_key: '@u_carol:c.example',
      sender: ALICE, origin_server_ts: 8, prev_events: [ '$bob_invite' ], auth_events: [ '$create', '$alice_join' ],
      content: { membership: 'invite' } }, 4);
    expect(replay.extend([ ...BASE, backfill ])).toBeUndefined();
    // A full replay still answers correctly.
    expect(resolveRoomState([ ...BASE, backfill ]).membership('@u_carol:c.example')).toBe('invite');
  });

  it('refuses a list that dropped an extremity', () => {
    const replay = MatrixRoomStateReplay.from(BASE);
    expect(replay.extend(BASE.filter(entry => entry.eventId !== '$bob_join'))).toBeUndefined();
  });

  it('extends through a fork and merges it', () => {
    const replay = MatrixRoomStateReplay.from(BASE);
    // Two children of the same extremity: a ban and a self-leave.
    const forked = replay.extend([ ...BASE, record(BOB_BAN, 5), record(BOB_LEAVE, 5) ]);
    expect(forked).toBeDefined();
    // The ban is a power event and wins, as a full replay also decides.
    expect(forked!.state.membership(BOB)).toBe('ban');
    expect(resolveRoomState([ ...BASE, record(BOB_BAN, 5), record(BOB_LEAVE, 5) ]).membership(BOB)).toBe('ban');

    // Appending a message that names both extremities merges them without a full replay.
    const merged = forked!.extend([ ...BASE, record(BOB_BAN, 5), record(BOB_LEAVE, 5),
      record({ event_id: '$merge', room_id: ROOM, type: 'm.room.message', sender: ALICE, origin_server_ts: 7,
        prev_events: [ '$bob_ban', '$bob_leave' ], auth_events: [ '$create', '$alice_join' ], content: { body: 'merge' } }, 6) ]);
    expect(merged).toBeDefined();
    expect(merged!.state.membership(BOB)).toBe('ban');
  });

  it('extends repeatedly, once per appended event', () => {
    let replay = MatrixRoomStateReplay.from(BASE);
    let events = [ ...BASE ];
    let parent = '$bob_join';
    for (let index = 0; index < 5; index += 1) {
      const event = record({ event_id: `$m${index}`, room_id: ROOM, type: 'm.room.message', sender: ALICE,
        origin_server_ts: 10 + index, prev_events: [ parent ], auth_events: [ '$create', '$alice_join' ],
        content: { body: `message ${index}` } }, 5 + index);
      events = [ ...events, event ];
      const next = replay.extend(events);
      expect(next, `extension ${index}`).toBeDefined();
      replay = next!;
      parent = `$m${index}`;
    }
    // Five single-event extensions leave the room's state intact.
    expect(replay.state.membership(BOB)).toBe('join');
    expect(replay.state.get('m.room.create')?.eventId).toBe('$create');
    expect(replay.extend(events)).toBe(replay);
  });

  it('falls back for a room written before the graph was recorded', () => {
    const legacy = [
      { eventId: '$old_member', roomId: ROOM, type: 'm.room.member', sender: ALICE, senderWebId: 'https://a/#me',
        originServerTs: 1, depth: 1, role: 'user', resourceId: 'a',
        stateKey: BOB, content: { membership: 'invite' } },
    ];
    const replay = MatrixRoomStateReplay.from(legacy);
    expect(replay.state.membership(BOB)).toBe('invite');
    expect(replay.extend(legacy)).toBeUndefined();
  });
});
