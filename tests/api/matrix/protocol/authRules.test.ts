import { describe, expect, it } from 'vitest';
import {
  authorizeEvent,
  isUserId,
  requiredPowerForEvent,
  serverNameOf,
  userPowerLevel,
  type AuthEvent,
  type AuthorizableEvent,
  type EventAuthDecision,
} from '../../../../src/api/matrix/protocol/authRules';

const ROOM = '!room:example.test';
const ALICE = '@u_alice:example.test';
const BOB = '@u_bob:example.test';
const CAROL = '@u_carol:example.test';

const create = {
  type: 'm.room.create', state_key: '', sender: ALICE, room_id: ROOM, event_id: '$create',
  prev_events: [], content: { room_version: '11', 'm.federate': true },
};

function member(userId: string, membership: string, extra: Record<string, unknown> = {}): AuthEvent {
  return {
    type: 'm.room.member', state_key: userId, sender: userId, room_id: ROOM,
    event_id: `$member_${userId}_${membership}`, content: { membership, ...extra },
  };
}

function powerLevels(content: Record<string, unknown>): AuthEvent {
  return { type: 'm.room.power_levels', state_key: '', sender: ALICE, room_id: ROOM, event_id: '$pl', content };
}

function joinRules(joinRule: string): AuthEvent {
  return { type: 'm.room.join_rules', state_key: '', sender: ALICE, room_id: ROOM, event_id: `$jr_${joinRule}`, content: { join_rule: joinRule } };
}

function message(sender: string): AuthorizableEvent {
  return { type: 'm.room.message', sender, room_id: ROOM, content: { msgtype: 'm.text', body: 'hi' } };
}

function memberEvent(stateKey: string, membership: string, input: Partial<AuthorizableEvent> = {}): AuthorizableEvent {
  return {
    type: 'm.room.member', state_key: stateKey, sender: stateKey, room_id: ROOM,
    content: { membership }, ...input,
  };
}

function check(event: AuthorizableEvent, authEvents: readonly AuthEvent[]): EventAuthDecision {
  return authorizeEvent(event, authEvents);
}

function expectAllowed(event: AuthorizableEvent, authEvents: readonly AuthEvent[]): void {
  const decision = check(event, authEvents);
  expect(decision.allowed, decision.reason).toBe(true);
}

function expectDenied(event: AuthorizableEvent, authEvents: readonly AuthEvent[], rule: RegExp): void {
  const decision = check(event, authEvents);
  expect(decision.allowed, `expected a denial, got ${decision.reason}`).toBe(false);
  expect(decision.reason).toMatch(rule);
}

describe('room v11 auth rules: create', () => {
  it('allows a root create event without a creator property', () => {
    // v11 removed `content.creator`; the sender is the creator.
    expectAllowed(create as AuthorizableEvent, []);
    expect(check(create as AuthorizableEvent, []).reason).toMatch(/1\.5/u);
  });

  it('rejects a create event with parents, a foreign room domain, or an unknown version', () => {
    expectDenied({ ...create, prev_events: [ '$other' ] } as AuthorizableEvent, [], /1\.1/u);
    expectDenied({ ...create, sender: '@u_bob:other.test' } as AuthorizableEvent, [], /1\.2/u);
    expectDenied({ ...create, content: { room_version: '10' } } as AuthorizableEvent, [], /1\.3/u);
  });
});

describe('room v11 auth rules: auth event selection', () => {
  const allowed = [ create as AuthEvent, powerLevels({ users: { [ALICE]: 100 } }), member(ALICE, 'join') ];

  it('accepts the selection the writer is supposed to make', () => {
    expectAllowed(message(ALICE), allowed);
  });

  it('rejects duplicates, foreign slots, a foreign room, rejected entries and a missing create', () => {
    expectDenied(message(ALICE), [ ...allowed, member(ALICE, 'join') ], /2\.1/u);
    expectDenied(message(ALICE), [ ...allowed, { type: 'm.room.name', state_key: '', sender: ALICE, room_id: ROOM, content: {} } ], /2\.2/u);
    expectDenied(message(ALICE), [
      create as AuthEvent, { ...member(ALICE, 'join'), room_id: '!other:example.test' },
    ], /2\.5/u);
    expectDenied(message(ALICE), [ create as AuthEvent, member(ALICE, 'join'), { ...powerLevels({}), rejected: true } ], /2\.3/u);
    expectDenied(message(ALICE), [ powerLevels({}), member(ALICE, 'join') ], /2\.4/u);
  });

  it('lets a member event select the target membership and join rules, and nothing else', () => {
    // A member event's selection is create, power levels, the sender's and the
    // target's membership, plus the join rules for join/invite/knock.
    const authEvents = [ create as AuthEvent, joinRules('invite'), member(BOB, 'invite') ];
    expectAllowed(memberEvent(BOB, 'join'), authEvents);
    expectDenied(memberEvent(BOB, 'join'), [ ...authEvents, member(ALICE, 'join') ], /2\.2/u);
  });
});

describe('room v11 auth rules: federation flag and membership gate', () => {
  it('keeps a non-federated room on its own server', () => {
    const nonFederated = { ...create, content: { room_version: '11', 'm.federate': false } } as AuthEvent;
    const DAVE = '@u_dave:other.test';
    expectDenied(message(DAVE), [ nonFederated, member(DAVE, 'join') ], /v11-3/u);
    // The creator's own server is still allowed.
    expectAllowed(message(ALICE), [ nonFederated, member(ALICE, 'join') ]);
  });

  it('refuses anything but a member event from a sender who is not joined', () => {
    expectDenied(message(BOB), [ create as AuthEvent ], /v11-5/u);
    expectDenied(message(BOB), [ create as AuthEvent, member(BOB, 'invite') ], /v11-5/u);
    expectDenied(
      { type: 'm.room.name', state_key: '', sender: BOB, room_id: ROOM, content: { name: 'x' } },
      [ create as AuthEvent, member(BOB, 'invite') ], /v11-5/u);
  });
});

describe('room v11 auth rules: joins', () => {
  it("allows the creator's initial join whose only parent is the create event", () => {
    expectAllowed(memberEvent(ALICE, 'join', { prev_events: [ '$create' ] }), [ create as AuthEvent ]);
    expect(check(memberEvent(ALICE, 'join', { prev_events: [ '$create' ] }), [ create as AuthEvent ]).reason).toMatch(/4\.3\.1/u);
  });

  it('does not treat another event hanging off the create event as the initial join', () => {
    // BOB is not the create event's sender, so rule 4.3.1 cannot apply.
    expectDenied(memberEvent(BOB, 'join', { prev_events: [ '$create' ] }), [ create as AuthEvent ], /4\.3\.4/u);
    // And the creator joining later is judged by the join rules, not rule 4.3.1.
    expectAllowed(memberEvent(ALICE, 'join', { prev_events: [ '$message' ] }), [ create as AuthEvent, member(ALICE, 'join') ]);
  });

  it('requires an invite under the default join rule and allows the invited user', () => {
    expectDenied(memberEvent(BOB, 'join'), [ create as AuthEvent ], /4\.3\.4/u);
    expectAllowed(memberEvent(BOB, 'join'), [ create as AuthEvent, member(BOB, 'invite') ]);
  });

  it('honours public, knock and restricted join rules', () => {
    expectAllowed(memberEvent(BOB, 'join'), [ create as AuthEvent, joinRules('public') ]);
    expectAllowed(memberEvent(BOB, 'join'), [ create as AuthEvent, joinRules('knock'), member(BOB, 'invite') ]);
    expectDenied(memberEvent(BOB, 'join'), [ create as AuthEvent, joinRules('restricted') ], /4\.3\.5\.2/u);
    expectAllowed(memberEvent(BOB, 'join'), [ create as AuthEvent, joinRules('restricted'), member(BOB, 'invite') ]);
  });

  it('rejects a banned sender and a sender that is not the state key', () => {
    expectDenied(memberEvent(BOB, 'join'), [ create as AuthEvent, member(BOB, 'ban') ], /4\.3\.3/u);
    expectDenied(
      memberEvent(BOB, 'join', { sender: ALICE }),
      [ create as AuthEvent, member(ALICE, 'join') ], /4\.3\.2/u);
  });

  it('fails closed on a restricted join that needs a signature this deployment cannot check', () => {
    expectDenied(
      memberEvent(BOB, 'join', { content: { membership: 'join', join_authorised_via_users_server: ALICE } }),
      [ create as AuthEvent, joinRules('restricted') ], /4\.2\.2/u);
  });
});

describe('room v11 auth rules: invites, leaves, bans, knocks', () => {
  it('invites need a joined sender, a free target and the invite level', () => {
    const joined = [ create as AuthEvent, member(ALICE, 'join') ];
    expectAllowed(memberEvent(BOB, 'invite', { sender: ALICE }), joined);
    expectDenied(memberEvent(BOB, 'invite', { sender: BOB }), [ create as AuthEvent ], /4\.4\.2/u);
    expectDenied(memberEvent(BOB, 'invite', { sender: ALICE }), [ ...joined, member(BOB, 'join') ], /4\.4\.3/u);
    expectDenied(memberEvent(BOB, 'invite', { sender: CAROL }), [
      create as AuthEvent, powerLevels({ invite: 50, users: { [CAROL]: 10 } }), member(CAROL, 'join'),
    ], /4\.4\.5/u);
    expectDenied(
      memberEvent(BOB, 'invite', { sender: ALICE, content: { membership: 'invite', third_party_invite: { signed: {} } } }),
      joined, /4\.4\.1/u);
  });

  it('lets a member leave, and requires kick power to remove someone else', () => {
    expectAllowed(memberEvent(ALICE, 'leave'), [ create as AuthEvent, member(ALICE, 'join') ]);
    expectDenied(memberEvent(ALICE, 'leave'), [ create as AuthEvent, member(ALICE, 'leave') ], /4\.5\.1/u);
    expectAllowed(memberEvent(CAROL, 'leave', { sender: ALICE }), [
      create as AuthEvent, member(ALICE, 'join'), member(CAROL, 'join'),
    ]);
    expectDenied(memberEvent(BOB, 'leave', { sender: CAROL }), [
      create as AuthEvent, powerLevels({ users: { [CAROL]: 0 } }), member(CAROL, 'join'), member(BOB, 'join'),
    ], /4\.5\.5/u);
  });

  it('unbanning needs the ban level, and kicking needs the target to be weaker', () => {
    expectAllowed(memberEvent(BOB, 'leave', { sender: CAROL }), [
      create as AuthEvent, powerLevels({ users: { [CAROL]: 50 } }), member(CAROL, 'join'), member(BOB, 'ban'),
    ]);
    expectDenied(memberEvent(BOB, 'leave', { sender: CAROL }), [
      create as AuthEvent, powerLevels({ users: { [CAROL]: 49 } }), member(CAROL, 'join'), member(BOB, 'ban'),
    ], /4\.5\.3/u);
    expectDenied(memberEvent(BOB, 'leave', { sender: ALICE }), [
      create as AuthEvent, powerLevels({ users: { [ALICE]: 50, [BOB]: 50 } }), member(ALICE, 'join'), member(BOB, 'join'),
    ], /4\.5\.5/u);
  });

  it('bans need the ban level and a weaker target', () => {
    expectAllowed(memberEvent(BOB, 'ban', { sender: ALICE }), [ create as AuthEvent, member(ALICE, 'join') ]);
    expectDenied(memberEvent(BOB, 'ban', { sender: ALICE }), [
      create as AuthEvent, powerLevels({ ban: 100, users: { [ALICE]: 50 } }), member(ALICE, 'join'),
    ], /4\.6\.3/u);
    expectDenied(memberEvent(ALICE, 'ban', { sender: CAROL }), [
      create as AuthEvent, powerLevels({ users: { [CAROL]: 50, [ALICE]: 50 } }), member(CAROL, 'join'),
    ], /4\.6\.3/u);
  });

  it('knocks only where the room accepts them', () => {
    expectAllowed(memberEvent(BOB, 'knock'), [ create as AuthEvent, joinRules('knock') ]);
    expectDenied(memberEvent(BOB, 'knock'), [ create as AuthEvent ], /4\.7\.1/u);
    expectDenied(memberEvent(BOB, 'knock'), [
      create as AuthEvent, joinRules('knock'), member(BOB, 'join'),
    ], /4\.7\.4/u);
  });

  it('rejects an unknown membership and member events without a state key or membership', () => {
    expectDenied(memberEvent(BOB, 'promote'), [ create as AuthEvent, member(BOB, 'join') ], /4\.8/u);
    expectDenied({ type: 'm.room.member', sender: BOB, room_id: ROOM, content: { membership: 'join' } },
      [ create as AuthEvent ], /4\.1/u);
    expectDenied({ type: 'm.room.member', state_key: BOB, sender: BOB, room_id: ROOM, content: {} },
      [ create as AuthEvent ], /4\.1/u);
  });
});

describe('room v11 auth rules: power levels and state', () => {
  it('meters state events by state_default and messages by events_default', () => {
    const joinedCarol = [ create as AuthEvent, powerLevels({ users: { [CAROL]: 0 } }), member(CAROL, 'join') ];
    expectDenied({ type: 'm.room.name', state_key: '', sender: CAROL, room_id: ROOM, content: { name: 'x' } },
      joinedCarol, /v11-7/u);
    expectAllowed({ type: 'm.room.name', state_key: '', sender: ALICE, room_id: ROOM, content: { name: 'x' } },
      [ create as AuthEvent, member(ALICE, 'join') ]);
    expectAllowed(message(CAROL), joinedCarol);
    expectAllowed({ type: 'm.room.name', state_key: '', sender: CAROL, room_id: ROOM, content: { name: 'x' } }, [
      create as AuthEvent, powerLevels({ events: { 'm.room.name': 0 }, users: { [CAROL]: 0 } }), member(CAROL, 'join'),
    ]);
    expectDenied(message(CAROL), [
      create as AuthEvent, powerLevels({ events_default: 50, users: { [CAROL]: 0 } }), member(CAROL, 'join'),
    ], /v11-7/u);
  });

  it('refuses a state key that names another user', () => {
    expectDenied({ type: 'm.room.topic', state_key: BOB, sender: ALICE, room_id: ROOM, content: { topic: 'x' } },
      [ create as AuthEvent, member(ALICE, 'join') ], /v11-8/u);
  });

  it('validates the shape of a power levels event', () => {
    const joined = [ create as AuthEvent, member(ALICE, 'join') ];
    expectDenied({ type: 'm.room.power_levels', state_key: '', sender: ALICE, room_id: ROOM, content: { users_default: '50' } }, joined, /9\.1/u);
    expectDenied({ type: 'm.room.power_levels', state_key: '', sender: ALICE, room_id: ROOM, content: { events: { 'm.room.name': 'high' } } }, joined, /9\.2/u);
    expectDenied({ type: 'm.room.power_levels', state_key: '', sender: ALICE, room_id: ROOM, content: { users: { 'not-a-user': 5 } } }, joined, /9\.3/u);
    expectDenied({ type: 'm.room.power_levels', state_key: '', sender: ALICE, room_id: ROOM, content: { users: { [BOB]: '5' } } }, joined, /9\.3/u);
    // The first power levels event in a room is allowed by 9.4.
    expectAllowed({ type: 'm.room.power_levels', state_key: '', sender: ALICE, room_id: ROOM, content: { users_default: 0 } }, joined);
  });

  it('forbids raising anything above the sender, or touching a peer', () => {
    const carolIs50 = [ create as AuthEvent, powerLevels({ users: { [CAROL]: 50 } }), member(CAROL, 'join') ];
    // 9.5.2: a new scalar above the sender's power.
    expectDenied({ type: 'm.room.power_levels', state_key: '', sender: CAROL, room_id: ROOM, content: { users_default: 100 } }, carolIs50, /9\.5\.2/u);
    // 9.5.1: the current scalar is already above the sender's power.
    expectDenied({ type: 'm.room.power_levels', state_key: '', sender: CAROL, room_id: ROOM, content: { users_default: 0 } }, [
      create as AuthEvent, powerLevels({ users_default: 100, users: { [CAROL]: 50 } }), member(CAROL, 'join'),
    ], /9\.5\.1/u);
    // 9.9: granting someone else more than the sender has.
    expectDenied({ type: 'm.room.power_levels', state_key: '', sender: CAROL, room_id: ROOM, content: { users: { [CAROL]: 50, [BOB]: 100 } } }, carolIs50, /9\.9/u);
    // 9.8: demoting a peer whose power is not below the sender's.
    expectDenied({ type: 'm.room.power_levels', state_key: '', sender: CAROL, room_id: ROOM, content: { users: { [CAROL]: 50, [BOB]: 10 } } }, [
      create as AuthEvent, powerLevels({ users: { [CAROL]: 50, [BOB]: 50 } }), member(CAROL, 'join'),
    ], /9\.8/u);
    // 9.6/9.7: event power entries.
    expectDenied({ type: 'm.room.power_levels', state_key: '', sender: CAROL, room_id: ROOM, content: { events: { 'm.room.name': 100 } } }, carolIs50, /9\.7/u);
    expectDenied({ type: 'm.room.power_levels', state_key: '', sender: CAROL, room_id: ROOM, content: { events: {} } }, [
      create as AuthEvent, powerLevels({ events: { 'm.room.name': 100 }, users: { [CAROL]: 50 } }), member(CAROL, 'join'),
    ], /9\.6/u);
  });

  it('lets a sender lower their own power and grant below their own', () => {
    expectAllowed({ type: 'm.room.power_levels', state_key: '', sender: CAROL, room_id: ROOM, content: { users: { [CAROL]: 0 } } }, [
      create as AuthEvent, powerLevels({ users: { [CAROL]: 50 } }), member(CAROL, 'join'),
    ]);
    expectAllowed({ type: 'm.room.power_levels', state_key: '', sender: CAROL, room_id: ROOM, content: { users: { [CAROL]: 50, [BOB]: 50 } } }, [
      create as AuthEvent, powerLevels({ users: { [CAROL]: 50 } }), member(CAROL, 'join'),
    ]);
  });

  it('reserves third-party invite events to the invite level', () => {
    expectAllowed({ type: 'm.room.third_party_invite', state_key: 'token', sender: ALICE, room_id: ROOM, content: {} },
      [ create as AuthEvent, member(ALICE, 'join') ]);
    expectDenied({ type: 'm.room.third_party_invite', state_key: 'token', sender: CAROL, room_id: ROOM, content: {} },
      [ create as AuthEvent, powerLevels({ invite: 50, users: { [CAROL]: 10 } }), member(CAROL, 'join') ], /v11-6/u);
  });
});

describe('power level defaults', () => {
  it('gives the creator 100 only while the room has no power levels event', () => {
    expect(userPowerLevel({ powerLevels: undefined, userId: ALICE, creator: ALICE })).toBe(100);
    expect(userPowerLevel({ powerLevels: undefined, userId: BOB, creator: ALICE })).toBe(0);
    // An explicit event replaces the implicit creator power entirely.
    expect(userPowerLevel({ powerLevels: {}, userId: ALICE, creator: ALICE })).toBe(0);
    expect(userPowerLevel({ powerLevels: { users_default: 5 }, userId: BOB, creator: ALICE })).toBe(5);
    expect(userPowerLevel({ powerLevels: { users: { [BOB]: 7 } }, userId: BOB, creator: ALICE })).toBe(7);
  });

  it('falls back to state_default and events_default per event kind', () => {
    expect(requiredPowerForEvent(undefined, 'm.room.message', false)).toBe(0);
    expect(requiredPowerForEvent(undefined, 'm.room.name', true)).toBe(50);
    expect(requiredPowerForEvent({ state_default: 60 }, 'm.room.name', true)).toBe(60);
    expect(requiredPowerForEvent({ events: { 'm.room.name': 10 } }, 'm.room.name', true)).toBe(10);
    expect(requiredPowerForEvent({ events_default: 20 }, 'm.room.message', false)).toBe(20);
  });

  it('parses the server half of IDs and recognizes user IDs', () => {
    expect(serverNameOf(ALICE)).toBe('example.test');
    expect(serverNameOf(ROOM)).toBe('example.test');
    expect(serverNameOf('@user:host:8448')).toBe('host:8448');
    expect(serverNameOf('garbage')).toBeUndefined();
    expect(serverNameOf(undefined)).toBeUndefined();
    expect(isUserId('@a:b')).toBe(true);
    expect(isUserId('@:b')).toBe(false);
    expect(isUserId('a:b')).toBe(false);
  });
});
