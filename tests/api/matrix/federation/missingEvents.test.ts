import { describe, expect, it } from 'vitest';
import { DEFAULT_MISSING_EVENTS_LIMIT, selectMissingEvents } from '../../../../src/api/matrix/federation/missingEvents';

function pdu(id: string, depth: number, prev: string[] = []): Record<string, unknown> {
  return { event_id: id, depth, prev_events: prev, type: 'm.room.message', content: { body: id } };
}

/** A -> B -> C -> D, the shape a walk backwards from D has to handle. */
const chain = [ pdu('$a', 1), pdu('$b', 2, [ '$a' ]), pdu('$c', 3, [ '$b' ]), pdu('$d', 4, [ '$c' ]) ];

describe('selecting the events a peer is missing', () => {
  it('walks back from the latest events, oldest first, without returning them', () => {
    const selection = selectMissingEvents(chain, { earliestEvents: [], latestEvents: [ '$d' ] });
    // Oldest first: the requester authorises these in order, and a dependent cannot be
    // authorised before its dependency.
    expect(selection.events.map(event => event.event_id)).toEqual([ '$a', '$b', '$c' ]);
    expect(selection.unavailable).toEqual([]);
  });

  it('stops at the events the requester says it has, and does not walk past them', () => {
    const selection = selectMissingEvents(chain, { earliestEvents: [ '$b' ], latestEvents: [ '$d' ] });
    // $b is the requester's, so $a (behind it) is its problem, not ours to send.
    expect(selection.events.map(event => event.event_id)).toEqual([ '$c' ]);
  });

  it('honours the limit and keeps the closest ancestors', () => {
    const selection = selectMissingEvents(chain, { earliestEvents: [], latestEvents: [ '$d' ], limit: 2 });
    expect(selection.events.map(event => event.event_id)).toEqual([ '$b', '$c' ]);
    // Default is the specification's 10.
    const wide = [ ...chain, pdu('$e', 5, [ '$d' ]), pdu('$f', 6, [ '$e' ]) ];
    expect(selectMissingEvents(wide, { earliestEvents: [], latestEvents: [ '$f' ] }).events).toHaveLength(5);
    expect(DEFAULT_MISSING_EVENTS_LIMIT).toBe(10);
    expect(selectMissingEvents(wide, { earliestEvents: [], latestEvents: [ '$f' ], limit: 0 }).events).toHaveLength(5);
  });

  it('does not return anything shallower than min_depth, and does not walk below it', () => {
    const selection = selectMissingEvents(chain, { earliestEvents: [], latestEvents: [ '$d' ], minDepth: 3 });
    expect(selection.events.map(event => event.event_id)).toEqual([ '$c' ]);
  });

  it('reports what it reached but does not hold, and keeps walking what it does', () => {
    // $missing sits between $c and $b and this server never saw it.
    const broken = [ pdu('$a', 1), pdu('$b', 2, [ '$a' ]), pdu('$c', 3, [ '$missing' ]), pdu('$d', 4, [ '$c' ]) ];
    const selection = selectMissingEvents(broken, { earliestEvents: [], latestEvents: [ '$d' ] });
    expect(selection.events.map(event => event.event_id)).toEqual([ '$c' ]);
    expect(selection.unavailable).toEqual([ '$missing' ]);
  });

  it('merges several latest events and visits each ancestor once', () => {
    const forked = [ pdu('$a', 1), pdu('$b', 2, [ '$a' ]), pdu('$c', 3, [ '$a' ]), pdu('$d', 4, [ '$b', '$c' ]) ];
    const selection = selectMissingEvents(forked, { earliestEvents: [], latestEvents: [ '$d' ] });
    expect(selection.events.map(event => event.event_id)).toEqual([ '$a', '$b', '$c' ]);
  });

  it('reads the parent list in either form, and tolerates a missing event id', () => {
    const mixed = [
      { event_id: '$a', depth: 1 },
      { event_id: '$b', depth: 2, prev_events: [ [ '$a', { sha256: 'x' } ] ] },
      { event_id: '$c', depth: 3, prev_events: 'nonsense' },
    ];
    expect(selectMissingEvents(mixed, { earliestEvents: [], latestEvents: [ '$b' ] }).events.map(event => event.event_id)).toEqual([ '$a' ]);
    expect(selectMissingEvents(mixed, { earliestEvents: [], latestEvents: [ '$c' ] }).events).toEqual([]);
    // An event with no id cannot be named by anything, so it is never returned.
    expect(selectMissingEvents([ { depth: 1, prev_events: [] } ], { earliestEvents: [], latestEvents: [] }).events).toEqual([]);
  });
});
