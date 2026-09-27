import { describe, expect, it } from 'vitest';
import { selectAuthChain } from '../../../../src/api/matrix/federation/authChain';

function pdu(id: string, depth: number, auth: string[] = []): Record<string, unknown> {
  return { event_id: id, depth, auth_events: auth, type: 'm.room.member' };
}

/** create <- alice's join <- bob's invite, the chain an invite depends on. */
const room = [
  pdu('$create', 1),
  pdu('$alice', 2, [ '$create' ]),
  pdu('$invite', 3, [ '$create', '$alice' ]),
];

describe('selecting an event\'s auth chain', () => {
  it('returns the event asked about and what authorises it, oldest first', () => {
    const selection = selectAuthChain(room, '$invite');
    expect(selection.chain.map(event => event.event_id)).toEqual([ '$create', '$alice', '$invite' ]);
    expect(selection.unavailable).toEqual([]);
  });

  it('follows the chain transitively and visits each event once', () => {
    const deep = [
      pdu('$create', 1),
      pdu('$power', 2, [ '$create' ]),
      pdu('$alice', 3, [ '$create', '$power' ]),
      pdu('$message', 4, [ '$create', '$alice' ]),
    ];
    expect(selectAuthChain(deep, '$message').chain.map(event => event.event_id)).toEqual([ '$create', '$power', '$alice', '$message' ]);
  });

  it('reports the ids it needed but does not hold', () => {
    const partial = [ pdu('$create', 1), pdu('$invite', 2, [ '$create', '$missing' ]) ];
    const selection = selectAuthChain(partial, '$invite');
    expect(selection.chain.map(event => event.event_id)).toEqual([ '$create', '$invite' ]);
    expect(selection.unavailable).toEqual([ '$missing' ]);
  });

  it('answers nothing useful for an event it does not hold', () => {
    expect(selectAuthChain(room, '$unknown')).toEqual({ chain: [], unavailable: [ '$unknown' ] });
  });

  it('reads the auth list in either form', () => {
    const mixed = [ pdu('$create', 1), { event_id: '$join', depth: 2, auth_events: [ [ '$create', { sha256: 'x' } ] ] } ];
    expect(selectAuthChain(mixed, '$join').chain.map(event => event.event_id)).toEqual([ '$create', '$join' ]);
  });
});
