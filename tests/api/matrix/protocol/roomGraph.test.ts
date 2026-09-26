import { describe, expect, it } from 'vitest';
import {
  MAX_EVENT_DEPTH,
  MAX_PREV_EVENTS,
  roomGraphPosition,
  type RoomGraphEvent,
} from '../../../../src/api/matrix/protocol/roomGraph';

function event(overrides: Partial<RoomGraphEvent> & { eventId: string }): RoomGraphEvent {
  return {
    type: 'm.room.message',
    sender: '@alice:example.org',
    content: { msgtype: 'm.text', body: overrides.eventId },
    sequence: Number(overrides.eventId.replace(/\D/gu, '')) || 1,
    prevEvents: [],
    ...overrides,
  };
}

/** create → join(alice) → message, the shape a real room starts with. */
function roomStart(): RoomGraphEvent[] {
  return [
    event({ eventId: 'e1', type: 'm.room.create', stateKey: '', sender: '@alice:example.org', depth: 1,
      content: { room_version: '11' } }),
    event({ eventId: 'e2', type: 'm.room.member', stateKey: '@alice:example.org', depth: 2,
      prevEvents: [ 'e1' ], content: { membership: 'join' } }),
  ];
}

describe('room graph position', () => {
  it('makes the create event the root', () => {
    expect(roomGraphPosition([], { type: 'm.room.create', sender: '@alice:example.org', stateKey: '', content: {} }))
      .toEqual({ prevEvents: [], authEvents: [], depth: 1 });
    // Even if a caller passes events, a create event still has no parents: the auth
    // rules reject it if it has any.
    expect(roomGraphPosition(roomStart(), { type: 'm.room.create', sender: '@alice:example.org', stateKey: '', content: {} }))
      .toEqual({ prevEvents: [], authEvents: [], depth: 1 });
  });

  it('attaches to the forward extremities with the depth the spec defines', () => {
    const position = roomGraphPosition(roomStart(), { type: 'm.room.message', sender: '@alice:example.org', content: {} });
    // Nothing references `e2` yet, so it is the only parent, and depth is its depth + 1.
    expect(position.prevEvents).toEqual([ 'e2' ]);
    expect(position.depth).toBe(3);
  });

  it('selects create, power levels and the sender membership as auth events', () => {
    const events = [
      ...roomStart(),
      event({ eventId: 'e3', type: 'm.room.power_levels', stateKey: '', depth: 3, prevEvents: [ 'e2' ],
        content: { users: { '@alice:example.org': 100 } } }),
      event({ eventId: 'e4', type: 'm.room.message', depth: 4, prevEvents: [ 'e3' ] }),
    ];
    const position = roomGraphPosition(events, { type: 'm.room.message', sender: '@alice:example.org', content: {} });
    expect(position.authEvents).toEqual([ 'e1', 'e3', 'e2' ]);
    expect(position.prevEvents).toEqual([ 'e4' ]);
  });

  it('replaces the previous state event for the same slot', () => {
    const events = [
      ...roomStart(),
      event({ eventId: 'e3', type: 'm.room.power_levels', stateKey: '', depth: 3, prevEvents: [ 'e2' ], content: { users: {} } }),
      event({ eventId: 'e4', type: 'm.room.power_levels', stateKey: '', depth: 4, prevEvents: [ 'e3' ], content: { users: {} } }),
    ];
    expect(roomGraphPosition(events, { type: 'm.room.message', sender: '@alice:example.org', content: {} }).authEvents)
      .toEqual([ 'e1', 'e4', 'e2' ]);
  });

  it('adds the target membership and the join rules to a member event', () => {
    const events = [
      ...roomStart(),
      event({ eventId: 'e3', type: 'm.room.join_rules', stateKey: '', depth: 3, prevEvents: [ 'e2' ], content: { join_rule: 'invite' } }),
      event({ eventId: 'e4', type: 'm.room.member', stateKey: '@bob:example.org', depth: 4, prevEvents: [ 'e3' ],
        content: { membership: 'invite' } }),
    ];
    // A join/invite/knock is checked against the join rules and the target's state.
    expect(roomGraphPosition(events, {
      type: 'm.room.member', sender: '@alice:example.org', stateKey: '@bob:example.org', content: { membership: 'join' },
    }).authEvents).toEqual([ 'e1', 'e2', 'e4', 'e3' ]);
    // A leave or ban is not: those are checked against the sender's own membership.
    expect(roomGraphPosition(events, {
      type: 'm.room.member', sender: '@alice:example.org', stateKey: '@bob:example.org', content: { membership: 'leave' },
    }).authEvents).toEqual([ 'e1', 'e2', 'e4' ]);
  });

  it('lists both sides of a fork, which is how a fork is merged', () => {
    // Two writers appended against the same parent, so neither has a child yet.
    const fork = [
      ...roomStart(),
      event({ eventId: 'e3', sequence: 3, depth: 3, prevEvents: [ 'e2' ] }),
      event({ eventId: 'e4', sequence: 4, depth: 3, prevEvents: [ 'e2' ] }),
    ];
    const position = roomGraphPosition(fork, { type: 'm.room.message', sender: '@alice:example.org', content: {} });
    expect([ ...position.prevEvents ].sort()).toEqual([ 'e3', 'e4' ]);
    expect(position.depth).toBe(4);
  });

  it('keeps the deepest extremities when the room has more than the cap allows', () => {
    const events = [
      ...roomStart(),
      ...Array.from({ length: MAX_PREV_EVENTS + 5 }, (_, index) => event({
        eventId: `e${index + 10}`, sequence: index + 10, depth: 3, prevEvents: [ 'e2' ],
      })),
    ];
    const position = roomGraphPosition(events, { type: 'm.room.message', sender: '@alice:example.org', content: {} });
    expect(position.prevEvents).toHaveLength(MAX_PREV_EVENTS);
    // Newest first: the lowest-sequence excess is what gets dropped.
    expect(position.prevEvents).not.toContain('e10');
    expect(position.prevEvents).toContain(`e${MAX_PREV_EVENTS + 14}`);
  });

  it('treats events written before the graph was recorded as the start of a chain', () => {
    // A stored event with no prev_events and no depth: it is an extremity, and a
    // child of it claims depth 2 rather than copying a depth it does not have.
    const legacy = [ event({ eventId: 'e1', type: 'm.room.create', stateKey: '', depth: undefined }) ];
    expect(roomGraphPosition(legacy, { type: 'm.room.message', sender: '@alice:example.org', content: {} }))
      .toEqual({ prevEvents: [ 'e1' ], authEvents: [ 'e1' ], depth: 2 });
  });

  it('caps the depth at the largest safe integer, as the spec requires', () => {
    const deep = [ event({ eventId: 'e1', depth: MAX_EVENT_DEPTH, prevEvents: [] }) ];
    expect(roomGraphPosition(deep, { type: 'm.room.message', sender: '@alice:example.org', content: {} }).depth)
      .toBe(MAX_EVENT_DEPTH);
  });

  it('is deterministic: the same room state yields the same position', () => {
    const events = roomStart();
    const next = { type: 'm.room.message' as const, sender: '@alice:example.org', content: { body: 'x' } };
    expect(roomGraphPosition(events, next)).toEqual(roomGraphPosition([ ...events ].reverse(), next));
  });

  it('does not select rejected-looking auth events it cannot see', () => {
    // Only the sender's membership is selected for a message: a ban on someone else
    // is not an auth event of this event, and an unknown sender selects nothing.
    const events = [
      ...roomStart(),
      event({ eventId: 'e3', type: 'm.room.member', stateKey: '@mallory:example.org', depth: 3, prevEvents: [ 'e2' ],
        content: { membership: 'ban' } }),
    ];
    expect(roomGraphPosition(events, { type: 'm.room.message', sender: '@carol:example.org', content: {} }).authEvents)
      .toEqual([ 'e1' ]);
  });
});
