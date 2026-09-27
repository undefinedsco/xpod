import { describe, expect, it } from 'vitest';
import { STRIPPED_STATE_TYPES, strippedRoomState, strippedStateWarnings } from '../../../../src/api/matrix/federation/strippedState';
import { computeEventId } from '../../../../src/api/matrix/protocol/eventIntegrity';
import type { MatrixEventRecord } from '../../../../src/api/matrix/types';

const ALICE = '@u_alice:alice.example';

/**
 * A row as the room's own deployment would have stored it: the event carries the id derived from
 * its content, as `buildPersistedEvent` leaves it, and the graph edges name those ids.
 */
function row(input: {
  type: string;
  stateKey?: string;
  prev?: string[];
  auth?: string[];
  content?: Record<string, unknown>;
  depth?: number;
}): MatrixEventRecord {
  const base: Record<string, unknown> = {
    room_id: '!r:alice.example',
    type: input.type,
    sender: ALICE,
    origin_server_ts: 1_000 + (input.depth ?? 1),
    depth: input.depth ?? 1,
    prev_events: input.prev ?? [],
    auth_events: input.auth ?? [],
    content: input.content ?? {},
    ...(input.stateKey === undefined ? {} : { state_key: input.stateKey }),
  };
  const eventId = computeEventId(base);
  return {
    eventId,
    roomId: '!r:alice.example',
    type: input.type,
    sender: ALICE,
    originServerTs: 1_000 + (input.depth ?? 1),
    depth: input.depth ?? 1,
    content: (input.content ?? {}) as Record<string, unknown>,
    ...(input.stateKey === undefined ? {} : { stateKey: input.stateKey }),
    event: { ...base, event_id: eventId },
  };
}

const create = row({ type: 'm.room.create', stateKey: '', content: { room_version: '11' } });
const join = row({ type: 'm.room.member', stateKey: ALICE, prev: [ create.eventId ], auth: [ create.eventId ], content: { membership: 'join' }, depth: 2 });
const name = row({ type: 'm.room.name', stateKey: '', prev: [ join.eventId ], auth: [ create.eventId, join.eventId ], content: { name: 'Room' }, depth: 3 });
const rules = row({ type: 'm.room.join_rules', stateKey: '', prev: [ name.eventId ], auth: [ create.eventId, join.eventId ], content: { join_rule: 'invite' }, depth: 4 });
const message = row({ type: 'm.room.message', prev: [ rules.eventId ], auth: [ create.eventId ], content: { body: 'hi' }, depth: 5 });

describe('the stripped state sent with an invite', () => {
  it('carries the room\'s display state and nothing else', () => {
    const stripped = strippedRoomState([ create, join, name, rules, message ]);

    // The create event is required, the rest are the events a client shows, in a fixed order.
    expect(stripped.map(event => event.type)).toEqual([ 'm.room.create', 'm.room.name', 'm.room.join_rules' ]);
    for (const event of stripped) {
      // Exactly the four fields a receiver may rely on, and no messaging event.
      expect(Object.keys(event).sort()).toEqual([ 'content', 'sender', 'state_key', 'type' ]);
    }
    expect(stripped[0]).toEqual({ type: 'm.room.create', state_key: '', sender: ALICE, content: { room_version: '11' } });
  });

  it('takes the state the room is actually in, not every state event it ever had', () => {
    // The rename is the event the room's state points at now; the superseded name is not sent.
    const renamed = row({
      type: 'm.room.name', stateKey: '', prev: [ rules.eventId ], auth: [ create.eventId, join.eventId ],
      content: { name: 'Renamed' }, depth: 6,
    });
    const stripped = strippedRoomState([ create, join, name, rules, renamed ]);
    expect(stripped.map(event => event.type)).toEqual([ 'm.room.create', 'm.room.name', 'm.room.join_rules' ]);
    expect(stripped.find(event => event.type === 'm.room.name')?.content).toEqual({ name: 'Renamed' });
    expect(STRIPPED_STATE_TYPES).toContain('m.room.avatar');
  });

  it('reports what is wrong with received stripped state, and nothing when it is fine', () => {
    expect(strippedStateWarnings(undefined)).toEqual([]);
    expect(strippedStateWarnings([ { type: 'm.room.create', state_key: '', sender: ALICE, content: {} } ])).toEqual([]);

    expect(strippedStateWarnings({ type: 'm.room.create' })).toEqual([ expect.stringMatching(/not an array/u) ]);
    expect(strippedStateWarnings([])).toEqual([]);
    expect(strippedStateWarnings([ 'nonsense' ])).toEqual([
      expect.stringMatching(/not an object/u),
      expect.stringMatching(/create event/u),
    ]);
    expect(strippedStateWarnings([ { type: 'm.room.name', state_key: '', sender: ALICE } ])).toEqual([
      expect.stringMatching(/no content/u),
      expect.stringMatching(/create event/u),
    ]);
    expect(strippedStateWarnings([ { type: 'm.room.name', state_key: '' } ])).toEqual([
      expect.stringMatching(/no sender, content/u),
      expect.stringMatching(/create event/u),
    ]);
    expect(strippedStateWarnings([ { type: 'm.room.create', state_key: '', sender: ALICE, content: {} } ])).toEqual([]);
  });
});
