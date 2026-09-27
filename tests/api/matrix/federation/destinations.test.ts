import { describe, expect, it } from 'vitest';
import { eventDestinations } from '../../../../src/api/matrix/federation/destinations';
import { MatrixRoomState } from '../../../../src/api/matrix/roomState';
import type { MatrixEventRecord } from '../../../../src/api/matrix/types';

const US = 'pod.example';

function member(userId: string, membership: string): MatrixEventRecord {
  return {
    eventId: `$member-${userId}-${membership}`,
    roomId: '!r:pod.example',
    type: 'm.room.member',
    sender: userId,
    stateKey: userId,
    content: { membership },
    originServerTs: 1_000,
    resourceId: 'r',
  } as MatrixEventRecord;
}

function state(...events: MatrixEventRecord[]): MatrixRoomState {
  return new MatrixRoomState(new Map(events.map(event => [ `${event.type}|${event.stateKey ?? ''}`, event ])));
}

describe('which servers receive an event', () => {
  it('sends to the servers of joined members, and not to our own', () => {
    const room = state(
      member('@u_alice:pod.example', 'join'),
      member('@u_bob:bob.example', 'join'),
      member('@u_carol:carol.example', 'join'),
    );
    expect(eventDestinations({ state: room, ourServerName: US })).toEqual([ 'bob.example', 'carol.example' ]);
  });

  it('skips servers whose member left or was banned', () => {
    const room = state(
      member('@u_alice:pod.example', 'join'),
      member('@u_bob:bob.example', 'leave'),
      member('@u_carol:carol.example', 'ban'),
      member('@u_dave:dave.example', 'invite'),
    );
    expect(eventDestinations({ state: room, ourServerName: US })).toEqual([]);
  });

  it('reaches the server of the member a membership event is about', () => {
    const room = state(member('@u_alice:pod.example', 'join'));
    expect(eventDestinations({
      state: room, ourServerName: US, event: { type: 'm.room.member', stateKey: '@u_bob:bob.example' },
    })).toEqual([ 'bob.example' ]);
    // A kick of somebody who is no longer joined still has to reach their server.
    expect(eventDestinations({
      state: room, ourServerName: US, event: { type: 'm.room.member', stateKey: '@u_carol:carol.example' },
    })).toEqual([ 'carol.example' ]);
  });

  it('never treats our own server as a destination, even for our own member event', () => {
    const room = state(member('@u_alice:pod.example', 'join'), member('@u_bob:bob.example', 'join'));
    expect(eventDestinations({
      state: room, ourServerName: US, event: { type: 'm.room.member', stateKey: '@u_alice:pod.example' },
    })).toEqual([ 'bob.example' ]);
  });

  it('returns each server once, in a stable order', () => {
    const room = state(
      member('@u_bob:bob.example', 'join'),
      member('@u_bob2:bob.example', 'join'),
      member('@u_ann:ann.example', 'join'),
    );
    expect(eventDestinations({ state: room, ourServerName: US })).toEqual([ 'ann.example', 'bob.example' ]);
  });

  it('ignores state that is not membership, and members with no usable id', () => {
    const room = state(
      { ...member('@u_alice:pod.example', 'join'), type: 'm.room.name', stateKey: '' } as MatrixEventRecord,
      { ...member('@u_bob:bob.example', 'join'), stateKey: undefined } as MatrixEventRecord,
      { ...member('@u_carol:carol.example', 'join'), content: { membership: 42 } } as MatrixEventRecord,
    );
    expect(eventDestinations({ state: room, ourServerName: US })).toEqual([]);
  });
});
