import { describe, expect, it } from 'vitest';
import { stateIdsBefore, stateSnapshotBefore } from '../../../../src/api/matrix/federation/roomStateSnapshot';
import type { MatrixEventRecord } from '../../../../src/api/matrix/types';

function record(input: {
  id: string;
  type: string;
  depth: number;
  stateKey?: string;
  prev?: string[];
  auth?: string[];
  content?: Record<string, unknown>;
}): MatrixEventRecord {
  const event: Record<string, unknown> = {
    event_id: input.id,
    room_id: '!r:alice.example',
    type: input.type,
    sender: '@u_alice:alice.example',
    origin_server_ts: 1_000 + input.depth,
    depth: input.depth,
    prev_events: input.prev ?? [],
    auth_events: input.auth ?? [],
    content: input.content ?? {},
    ...(input.stateKey === undefined ? {} : { state_key: input.stateKey }),
  };
  return {
    eventId: input.id,
    roomId: '!r:alice.example',
    type: input.type,
    sender: '@u_alice:alice.example',
    originServerTs: 1_000 + input.depth,
    depth: input.depth,
    content: (input.content ?? {}) as Record<string, unknown>,
    ...(input.stateKey === undefined ? {} : { stateKey: input.stateKey }),
    event,
  };
}

/** create -> alice joins -> power levels -> a name -> a message. */
const room = [
  record({ id: '$create', type: 'm.room.create', depth: 1, stateKey: '', content: { room_version: '11' } }),
  record({ id: '$alice', type: 'm.room.member', depth: 2, stateKey: '@u_alice:alice.example', prev: [ '$create' ], auth: [ '$create' ], content: { membership: 'join' } }),
  record({ id: '$power', type: 'm.room.power_levels', depth: 3, stateKey: '', prev: [ '$alice' ], auth: [ '$create', '$alice' ], content: { users: {} } }),
  record({ id: '$name', type: 'm.room.name', depth: 4, stateKey: '', prev: [ '$power' ], auth: [ '$create', '$alice', '$power' ], content: { name: 'Room' } }),
  record({ id: '$message', type: 'm.room.message', depth: 5, prev: [ '$name' ], auth: [ '$create', '$alice', '$power' ], content: { body: 'hi' } }),
];

const ids = (events: readonly Record<string, unknown>[]) => events.map(event => String(event.event_id)).sort();

describe('the state at an event', () => {
  it('answers with the resolved state before the event, and the auth chain it rests on', () => {
    const snapshot = stateSnapshotBefore(room, '$message');
    // Everything the room's state consists of at that point, including the name event.
    expect(ids(snapshot!.pdus)).toEqual([ '$alice', '$create', '$name', '$power' ]);
    // The state events themselves plus everything that authorises them, recursively.
    expect(ids(snapshot!.authChain)).toEqual([ '$alice', '$create', '$name', '$power' ]);
    expect(snapshot!.unavailable).toEqual([]);
  });

  it('does not consider the event\'s own state change', () => {
    // Asking at the name event answers with the state *before* it was named.
    const snapshot = stateSnapshotBefore(room, '$name');
    expect(ids(snapshot!.pdus)).toEqual([ '$alice', '$create', '$power' ]);
  });

  it('leaves timeline events out of the state', () => {
    const snapshot = stateSnapshotBefore(room, '$message');
    expect(snapshot!.pdus.some(event => event.type === 'm.room.message')).toBe(false);
  });

  it('answers the same thing as ids, which is all a server with the events needs', () => {
    const snapshot = stateIdsBefore(room, '$message');
    expect(snapshot!.pduIds).toEqual([ '$alice', '$create', '$name', '$power' ]);
    expect(snapshot!.authChainIds).toEqual([ '$alice', '$create', '$name', '$power' ]);
    expect(snapshot!.unavailable).toEqual([]);
  });

  it('reports an auth event it does not hold instead of pretending the chain is complete', () => {
    // The power levels event names an authoriser this server never saw.
    const partial = [
      record({ id: '$create', type: 'm.room.create', depth: 1, stateKey: '', content: { room_version: '11' } }),
      record({ id: '$alice', type: 'm.room.member', depth: 2, stateKey: '@u_alice:alice.example', prev: [ '$create' ], auth: [ '$create' ], content: { membership: 'join' } }),
      record({ id: '$power', type: 'm.room.power_levels', depth: 3, stateKey: '', prev: [ '$alice' ], auth: [ '$create', '$alice', '$missing' ], content: { users: {} } }),
      record({ id: '$message', type: 'm.room.message', depth: 4, prev: [ '$power' ], auth: [ '$create', '$alice', '$power' ], content: { body: 'hi' } }),
    ];
    const snapshot = stateIdsBefore(partial, '$message');
    expect(snapshot!.pduIds).toEqual([ '$alice', '$create', '$power' ]);
    expect(snapshot!.unavailable).toEqual([ '$missing' ]);
  });

  it('has no answer for an event it does not hold', () => {
    expect(stateSnapshotBefore(room, '$unknown')).toBeUndefined();
    expect(stateIdsBefore(room, '$unknown')).toBeUndefined();
  });

  it('reads a fork: the state before an event is the resolution of its parents', () => {
    // A second name event on the same slot, forked from the first.
    const forked = [ ...room, record({ id: '$name2', type: 'm.room.name', depth: 6, stateKey: '', prev: [ '$message' ], auth: [ '$create', '$alice', '$power' ], content: { name: 'Other' } }) ];
    const snapshot = stateSnapshotBefore(forked, '$name2');
    // The fork resolves across both branches, so the room keeps the state it had.
    expect(ids(snapshot!.pdus)).toEqual([ '$alice', '$create', '$name', '$power' ]);
  });
});
