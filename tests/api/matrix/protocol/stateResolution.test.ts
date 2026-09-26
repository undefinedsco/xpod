import { describe, expect, it } from 'vitest';
import {
  authChain,
  authDifference,
  classifyStates,
  isPowerEvent,
  iterativeAuthChecks,
  mainlineOf,
  mainlineOrdering,
  mainlinePosition,
  resolveState,
  reverseTopologicalPowerOrdering,
  stateAfter,
  stateKeyOf,
  type StateMap,
  type StateResolutionEvent,
  type StateResolutionStore,
} from '../../../../src/api/matrix/protocol/stateResolution';

const ROOM = '!r:example.test';
const ALICE = '@u_alice:example.test';
const BOB = '@u_bob:example.test';

const CREATE: StateResolutionEvent = {
  event_id: '$create', room_id: ROOM, type: 'm.room.create', state_key: '', sender: ALICE,
  content: { room_version: '11' }, origin_server_ts: 1, auth_events: [], prev_events: [],
};
const ALICE_JOIN: StateResolutionEvent = {
  event_id: '$alice_join', room_id: ROOM, type: 'm.room.member', state_key: ALICE, sender: ALICE,
  content: { membership: 'join' }, origin_server_ts: 2, auth_events: [ '$create' ], prev_events: [ '$create' ],
};
/** The room's first power levels event: ALICE 100, everyone else 0. */
const POWER_LEVELS: StateResolutionEvent = {
  event_id: '$power', room_id: ROOM, type: 'm.room.power_levels', state_key: '', sender: ALICE,
  content: { users: { [ALICE]: 100 }, users_default: 0, state_default: 50, events_default: 0, ban: 50, kick: 50, invite: 0 },
  origin_server_ts: 3, auth_events: [ '$create', '$alice_join' ], prev_events: [ '$alice_join' ],
};
const BOB_INVITE: StateResolutionEvent = {
  event_id: '$bob_invite', room_id: ROOM, type: 'm.room.member', state_key: BOB, sender: ALICE,
  content: { membership: 'invite' }, origin_server_ts: 4,
  auth_events: [ '$create', '$power', '$alice_join' ], prev_events: [ '$power' ],
};
const BOB_JOIN: StateResolutionEvent = {
  event_id: '$bob_join', room_id: ROOM, type: 'm.room.member', state_key: BOB, sender: BOB,
  content: { membership: 'join' }, origin_server_ts: 5,
  auth_events: [ '$create', '$power', '$bob_invite' ], prev_events: [ '$bob_invite' ],
};
/** Fork A: ALICE bans BOB. A power event, so it is resolved first. */
const BOB_BAN: StateResolutionEvent = {
  event_id: '$bob_ban', room_id: ROOM, type: 'm.room.member', state_key: BOB, sender: ALICE,
  content: { membership: 'ban' }, origin_server_ts: 200,
  auth_events: [ '$create', '$power', '$alice_join', '$bob_join' ], prev_events: [ '$bob_join' ],
};
/** Fork B: BOB leaves on his own. Not a power event. */
const BOB_LEAVE: StateResolutionEvent = {
  event_id: '$bob_leave', room_id: ROOM, type: 'm.room.member', state_key: BOB, sender: BOB,
  content: { membership: 'leave' }, origin_server_ts: 210,
  auth_events: [ '$create', '$power', '$bob_join' ], prev_events: [ '$bob_join' ],
};

const GRAPH = [ CREATE, ALICE_JOIN, POWER_LEVELS, BOB_INVITE, BOB_JOIN, BOB_BAN, BOB_LEAVE ];

function storeOf(events: readonly StateResolutionEvent[]): StateResolutionStore {
  const byId = new Map(events.map(event => [ event.event_id, event ]));
  return { event: (eventId: string) => byId.get(eventId) };
}

const store = storeOf(GRAPH);

/** The state after the shared prefix, before the fork. */
const BASE_STATE: StateMap = new Map([
  [ 'm.room.create|', CREATE.event_id ],
  [ `m.room.member|${ALICE}`, ALICE_JOIN.event_id ],
  [ 'm.room.power_levels|', POWER_LEVELS.event_id ],
  [ `m.room.member|${BOB}`, BOB_JOIN.event_id ],
]);

const AFTER_BAN = stateAfter(BOB_BAN, BASE_STATE);
const AFTER_LEAVE = stateAfter(BOB_LEAVE, BASE_STATE);

describe('state resolution: state maps', () => {
  it('only state events change the state, and they replace their own slot', () => {
    expect(stateKeyOf(CREATE)).toBe('m.room.create|');
    expect(stateKeyOf({ ...CREATE, state_key: undefined })).toBeUndefined();
    expect(stateKeyOf(BOB_BAN)).toBe(`m.room.member|${BOB}`);

    const afterMessage = stateAfter({ event_id: '$msg', room_id: ROOM, type: 'm.room.message', sender: ALICE, content: {} }, BASE_STATE);
    expect(afterMessage).toEqual(BASE_STATE);
    expect(AFTER_BAN.get(`m.room.member|${BOB}`)).toBe(BOB_BAN.event_id);
    expect(AFTER_BAN.get('m.room.power_levels|')).toBe(POWER_LEVELS.event_id);
  });

  it('classifies a key as unconflicted only when every state agrees on its value', () => {
    const { unconflicted, conflicted } = classifyStates([ AFTER_BAN, AFTER_LEAVE ]);
    expect([ ...unconflicted.keys() ].sort()).toEqual([ 'm.room.create|', `m.room.member|${ALICE}`, 'm.room.power_levels|' ].sort());
    expect([ ...conflicted ].sort()).toEqual([ BOB_BAN.event_id, BOB_LEAVE.event_id ]);
    // A key missing from one state is conflicted even though its value is the same
    // event on the other side.
    const missing = new Map(AFTER_BAN);
    missing.delete('m.room.power_levels|');
    expect([ ...classifyStates([ AFTER_BAN, missing ]).conflicted ]).toEqual([ POWER_LEVELS.event_id ]);
  });

  it('recognizes the state events that can remove someone else\'s power', () => {
    expect(isPowerEvent(POWER_LEVELS)).toBe(true);
    expect(isPowerEvent(BOB_BAN)).toBe(true);
    // A member leaving on their own cannot remove anyone else's power.
    expect(isPowerEvent(BOB_LEAVE)).toBe(false);
    expect(isPowerEvent(BOB_JOIN)).toBe(false);
    expect(isPowerEvent({ type: 'm.room.message', event_id: '$m' })).toBe(false);
  });
});

describe('state resolution: auth chains', () => {
  it('walks auth events without including the event itself', () => {
    expect([ ...authChain(BOB_BAN.event_id, store) ].sort())
      .toEqual([ '$alice_join', '$bob_invite', '$bob_join', '$create', '$power' ].sort());
    expect([ ...authChain(CREATE.event_id, store) ]).toEqual([]);
  });

  it('takes the difference of the states\' full auth chains', () => {
    // Both forks share the same auth chain, so nothing is in the difference.
    expect([ ...authDifference([ AFTER_BAN, AFTER_LEAVE ], store) ]).toEqual([]);
    // An event reachable from one branch's auth chain but not from every branch's is
    // exactly what the difference collects.
    const root: StateResolutionEvent = { event_id: '$root', room_id: ROOM, type: 'm.room.create', sender: ALICE, content: {}, auth_events: [] };
    const onlyB: StateResolutionEvent = { event_id: '$only_b', room_id: ROOM, type: 'm.room.power_levels', sender: ALICE, content: {}, auth_events: [ '$root' ] };
    const stateA: StateMap = new Map([ [ 'x|', '$a1' ] ]);
    const stateB: StateMap = new Map([ [ 'x|', '$b1' ] ]);
    const explicit = storeOf([
      root, onlyB,
      { event_id: '$a1', room_id: ROOM, type: 'm.room.topic', state_key: '', sender: ALICE, content: {}, auth_events: [ '$root' ] },
      { event_id: '$b1', room_id: ROOM, type: 'm.room.topic', state_key: '', sender: ALICE, content: {}, auth_events: [ '$root', '$only_b' ] },
    ]);
    expect([ ...authDifference([ stateA, stateB ], explicit) ].sort()).toEqual([ '$only_b' ]);
  });
});

describe('state resolution: orderings', () => {
  it('orders power events by sender power, then time, then id', () => {
    const later: StateResolutionEvent = { ...POWER_LEVELS, event_id: '$power_later', origin_server_ts: 10 };
    const earlier: StateResolutionEvent = { ...POWER_LEVELS, event_id: '$power_earlier', origin_server_ts: 9 };
    expect(reverseTopologicalPowerOrdering([ later, earlier ], storeOf([ later, earlier ])).map(event => event.event_id))
      .toEqual([ '$power_earlier', '$power_later' ]);

    // The same timestamp falls back to the event id, so the order is still total.
    const a: StateResolutionEvent = { ...POWER_LEVELS, event_id: '$a', origin_server_ts: 9 };
    expect(reverseTopologicalPowerOrdering([ later, a ], storeOf([ later, a ])).map(event => event.event_id))
      .toEqual([ '$a', '$power_later' ]);

    // A more powerful sender goes first even when their event is newer.
    const powerful: StateResolutionEvent = { ...POWER_LEVELS, event_id: '$by_alice', origin_server_ts: 20 };
    const weak: StateResolutionEvent = {
      ...POWER_LEVELS, event_id: '$by_bob', sender: BOB, origin_server_ts: 3,
      auth_events: [ '$create', '$power', '$bob_join' ],
    };
    // BOB has no entry in `$power`, so his power is users_default: 0, and the more
    // powerful sender's event is ordered first however new it is.
    expect(reverseTopologicalPowerOrdering([ weak, powerful ], storeOf([ ...GRAPH, weak, powerful ]))
      .map(event => event.event_id)).toEqual([ '$by_alice', '$by_bob' ]);
  });

  it('orders by the mainline of the resolved power levels event', () => {
    // $power is the mainline head; $alice_join has no power levels in its chain.
    const mainline = mainlineOf(POWER_LEVELS, store);
    expect(mainline.map(event => event.event_id)).toEqual([ '$power' ]);
    expect(mainlinePosition(BOB_BAN, mainline, store)).toBe(0);
    expect(mainlinePosition(BOB_LEAVE, mainline, store)).toBe(0);
    // An event that never cites a power levels event has no mainline position.
    expect(mainlinePosition(ALICE_JOIN, mainline, store)).toBe(Number.POSITIVE_INFINITY);
    // Rule order: a *greater* mainline position sorts first, and an event that never
    // cites a power levels event has position infinity — the oldest of all.
    expect(mainlineOrdering([ ALICE_JOIN, BOB_BAN ], POWER_LEVELS, store).map(event => event.event_id))
      .toEqual([ '$alice_join', '$bob_ban' ]);
  });

  it('follows the auth chain to find older power levels events in the mainline', () => {
    const older: StateResolutionEvent = { ...POWER_LEVELS, event_id: '$power_older', auth_events: [ '$create', '$alice_join' ] };
    const newer: StateResolutionEvent = { ...POWER_LEVELS, event_id: '$power_newer', auth_events: [ '$create', '$alice_join', '$power_older' ] };
    const store2 = storeOf([ older, newer, ALICE_JOIN ]);
    expect(mainlineOf(newer, store2).map(event => event.event_id)).toEqual([ '$power_newer', '$power_older' ]);
    const mainline = mainlineOf(newer, store2);

    // Based on the newer event (position 0) versus the older one (position 1): the
    // event whose chain reaches the *earlier* mainline event sorts first.
    const basedOnNewer: StateResolutionEvent = { ...POWER_LEVELS, event_id: '$x', auth_events: [ '$power_newer' ] };
    const basedOnOlder: StateResolutionEvent = { ...POWER_LEVELS, event_id: '$y', auth_events: [ '$power_older' ] };
    expect(mainlinePosition(basedOnNewer, mainline, store2)).toBe(0);
    expect(mainlinePosition(basedOnOlder, mainline, store2)).toBe(1);
    expect(mainlineOrdering([ basedOnNewer, basedOnOlder ], newer, store2).map(event => event.event_id))
      .toEqual([ '$y', '$x' ]);
  });
});

describe('state resolution: iterative auth checks', () => {
  it('applies an event the rules allow and ignores one they refuse', () => {
    const applied = iterativeAuthChecks(BASE_STATE, [ BOB_BAN ], store);
    expect(applied.get(`m.room.member|${BOB}`)).toBe(BOB_BAN.event_id);

    // A ban from someone without the ban level must not enter the state.
    const weakBan: StateResolutionEvent = {
      ...BOB_BAN, event_id: '$weak_ban', sender: BOB,
      auth_events: [ '$create', '$power', '$bob_join' ],
    };
    const ignored = iterativeAuthChecks(BASE_STATE, [ weakBan ], storeOf([ ...GRAPH, weakBan ]));
    expect(ignored.get(`m.room.member|${BOB}`)).toBe(BOB_JOIN.event_id);
  });

  it('falls back to the event\'s own auth events for slots the state lacks', () => {
    // The state has no power levels event, so the ban is judged against the one the
    // event cites — which gives ALICE the power to ban.
    const withoutPower = new Map(BASE_STATE);
    withoutPower.delete('m.room.power_levels|');
    const resolved = iterativeAuthChecks(withoutPower, [ BOB_BAN ], store);
    expect(resolved.get(`m.room.member|${BOB}`)).toBe(BOB_BAN.event_id);
  });

  it('does not use a rejected auth event as a substitute', () => {
    // BOB's permission to send state comes from this power levels event alone, so the
    // outcome shows whether a rejected entry was used as the fallback.
    const bobPower: StateResolutionEvent = {
      ...POWER_LEVELS, event_id: '$power_bob',
      content: { users: { [ALICE]: 100, [BOB]: 50 }, state_default: 50 },
    };
    const topic: StateResolutionEvent = {
      event_id: '$topic_by_bob', room_id: ROOM, type: 'm.room.topic', state_key: '', sender: BOB,
      content: { topic: 'from bob' }, origin_server_ts: 500,
      auth_events: [ '$create', '$power_bob', '$bob_join' ],
    };
    const withoutPower = new Map(BASE_STATE);
    withoutPower.delete('m.room.power_levels|');

    const usable = storeOf([ ...GRAPH, bobPower, topic ]);
    expect(iterativeAuthChecks(withoutPower, [ topic ], usable).get('m.room.topic|')).toBe(topic.event_id);

    const rejected = storeOf([ ...GRAPH, { ...bobPower, rejected: true }, topic ]);
    expect(iterativeAuthChecks(withoutPower, [ topic ], rejected).get('m.room.topic|')).toBeUndefined();
  });
});

describe('state resolution: resolving a fork', () => {
  it('returns a single state set unchanged', () => {
    expect(resolveState([ BASE_STATE ], store)).toEqual(BASE_STATE);
    expect(resolveState([], store)).toEqual(new Map());
  });

  it('prefers the ban over the self-leave, whichever order the branches arrive in', () => {
    for (const states of [ [ AFTER_BAN, AFTER_LEAVE ], [ AFTER_LEAVE, AFTER_BAN ] ]) {
      const resolved = resolveState(states, store);
      // The power event is applied first, so the self-leave is refused against the
      // ban and the two branches converge on the ban.
      expect(resolved.get(`m.room.member|${BOB}`)).toBe(BOB_BAN.event_id);
      // Unconflicted keys are untouched by the conflict.
      expect(resolved.get('m.room.create|')).toBe(CREATE.event_id);
      expect(resolved.get(`m.room.member|${ALICE}`)).toBe(ALICE_JOIN.event_id);
      expect(resolved.get('m.room.power_levels|')).toBe(POWER_LEVELS.event_id);
    }
  });

  it('resolves two conflicting power levels events deterministically', () => {
    const raise: StateResolutionEvent = {
      ...POWER_LEVELS, event_id: '$pl_raise', origin_server_ts: 300,
      content: { users: { [ALICE]: 100, [BOB]: 50 }, ban: 50 },
    };
    const lower: StateResolutionEvent = {
      ...POWER_LEVELS, event_id: '$pl_lower', origin_server_ts: 310,
      content: { users: { [ALICE]: 100, [BOB]: 0 }, ban: 50 },
    };
    const store2 = storeOf([ ...GRAPH, raise, lower ]);
    const branchA = stateAfter(raise, BASE_STATE);
    const branchB = stateAfter(lower, BASE_STATE);

    const first = resolveState([ branchA, branchB ], store2);
    const second = resolveState([ branchB, branchA ], store2);
    expect([ ...first.entries() ]).toEqual([ ...second.entries() ]);
    // Same sender, so time decides: the later event is applied last and wins.
    expect(first.get('m.room.power_levels|')).toBe(lower.event_id);
  });

  it('keeps a key that only one branch changed away from the unconflicted map', () => {
    const topicA: StateResolutionEvent = {
      event_id: '$topic_a', room_id: ROOM, type: 'm.room.topic', state_key: '', sender: ALICE,
      content: { topic: 'A' }, origin_server_ts: 400, auth_events: [ '$create', '$power', '$alice_join' ],
    };
    const store2 = storeOf([ ...GRAPH, topicA ]);
    // branchA has a topic, branchB has none at all: the key is conflicted, and the
    // event is applied because ALICE may send state.
    const branchA = stateAfter(topicA, BASE_STATE);
    const resolved = resolveState([ branchA, BASE_STATE ], store2);
    expect(resolved.get('m.room.topic|')).toBe(topicA.event_id);
  });
});
