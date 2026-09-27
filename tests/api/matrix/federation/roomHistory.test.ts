import { describe, expect, it } from 'vitest';
import { MAX_BACKFILL_LIMIT, selectBackfill } from '../../../../src/api/matrix/federation/roomHistory';

function pdu(id: string, depth: number, prev: string[] = []): Record<string, unknown> {
  return { event_id: id, depth, prev_events: prev, type: 'm.room.message' };
}

/** A -> B -> C -> D -> E, the shape a backfill walks. */
const chain = [
  pdu('$a', 1), pdu('$b', 2, [ '$a' ]), pdu('$c', 3, [ '$b' ]), pdu('$d', 4, [ '$c' ]), pdu('$e', 5, [ '$d' ]),
];

describe('selecting a backfill window', () => {
  it('includes the events it was asked from, newest first', () => {
    const selection = selectBackfill(chain, { from: [ '$e' ], limit: 3 });
    expect(selection.pdus.map(event => event.event_id)).toEqual([ '$e', '$d', '$c' ]);
    expect(selection.unavailable).toEqual([]);
  });

  it('fills the window with the closest ancestors when the limit bites', () => {
    const selection = selectBackfill(chain, { from: [ '$e' ], limit: 2 });
    expect(selection.pdus.map(event => event.event_id)).toEqual([ '$e', '$d' ]);
    // A limit that reaches the beginning stops there rather than failing.
    expect(selectBackfill(chain, { from: [ '$e' ], limit: 99 }).pdus).toHaveLength(5);
  });

  it('merges several starting points without repeating an ancestor', () => {
    const forked = [ pdu('$a', 1), pdu('$b', 2, [ '$a' ]), pdu('$c', 3, [ '$a' ]), pdu('$d', 4, [ '$b', '$c' ]) ];
    const selection = selectBackfill(forked, { from: [ '$b', '$c' ], limit: 10 });
    expect(selection.pdus.map(event => event.event_id)).toEqual([ '$c', '$b', '$a' ]);
  });

  it('reports what it does not hold and keeps walking what it does', () => {
    const broken = [ pdu('$a', 1), pdu('$c', 3, [ '$missing' ]) ];
    const selection = selectBackfill(broken, { from: [ '$c' ], limit: 10 });
    expect(selection.pdus.map(event => event.event_id)).toEqual([ '$c' ]);
    expect(selection.unavailable).toEqual([ '$missing' ]);
  });

  it('bounds a nonsensical or oversized limit', () => {
    expect(selectBackfill(chain, { from: [ '$e' ], limit: 0 }).pdus).toHaveLength(1);
    expect(selectBackfill(chain, { from: [ '$e' ], limit: -5 }).pdus).toHaveLength(1);
    const many = Array.from({ length: 200 }, (_, index) => pdu(`$${index}`, index + 1, index === 0 ? [] : [ `$${index - 1}` ]));
    expect(selectBackfill(many, { from: [ '$199' ], limit: 10_000 }).pdus).toHaveLength(MAX_BACKFILL_LIMIT);
  });

  it('reads prev_events in either list form, and answers nothing for an unknown start', () => {
    const mixed = [
      { event_id: '$a', depth: 1 },
      { event_id: '$b', depth: 2, prev_events: [ [ '$a', { sha256: 'x' } ] ] },
    ];
    expect(selectBackfill(mixed, { from: [ '$b' ], limit: 5 }).pdus.map(event => event.event_id)).toEqual([ '$b', '$a' ]);
    expect(selectBackfill(mixed, { from: [ '$nope' ], limit: 5 })).toEqual({ pdus: [], unavailable: [ '$nope' ] });
  });
});
