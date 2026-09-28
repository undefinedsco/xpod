import { describe, expect, it } from 'vitest';
import { inboundWriteAuthority } from '../../../src/api/matrix/inboundAuthority';

describe('who may write an inbound event for a participant', () => {
  it('refuses without a grant, whatever the room says', () => {
    for (const membership of [ undefined, 'join', 'invite' ] as const) {
      const answer = inboundWriteAuthority({ grant: false, type: 'm.room.message', ...(membership === undefined ? {} : { membership }) });
      expect(answer.allowed).toBe(false);
      expect(answer.allowed === false ? answer.reason : '').toMatch(/holds no grant/u);
    }
    // Even a membership event: the grant is the floor, not the membership.
    expect(inboundWriteAuthority({ grant: false, type: 'm.room.member' }).allowed).toBe(false);
  });

  it('writes a message for a member', () => {
    expect(inboundWriteAuthority({ grant: true, type: 'm.room.message', membership: 'join' }))
      .toEqual({ allowed: true, reason: 'member' });
  });

  it('refuses a message the resolved state says its owner is out of the room for', () => {
    for (const membership of [ 'invite', 'leave', 'ban', 'knock' ] as const) {
      const answer = inboundWriteAuthority({ grant: true, type: 'm.room.message', membership });
      expect(answer.allowed).toBe(false);
      expect(answer.allowed === false ? answer.reason : '').toContain(membership);
    }
  });

  it('allows the events that establish a membership this Pod does not know yet', () => {
    // A remote join delivers the room as it was *before* the join — create, join rules, power levels
    // — while this Pod has no membership for the participant. Refusing "unknown" would refuse the
    // handshake's own first step, so unknown is not a refusal.
    expect(inboundWriteAuthority({ grant: true, type: 'm.room.create' }))
      .toEqual({ allowed: true, reason: 'membership not established yet' });
    expect(inboundWriteAuthority({ grant: true, type: 'm.room.join_rules' }).allowed).toBe(true);
    expect(inboundWriteAuthority({ grant: true, type: 'm.room.message' }).allowed).toBe(true);
  });

  it('writes the events that change membership, which is how anyone gets in', () => {
    // An invite's whole job is to tell somebody about a room they are not in yet; gating it on
    // membership would refuse the one event that could ever make them a member.
    expect(inboundWriteAuthority({ grant: true, type: 'm.room.member' }))
      .toEqual({ allowed: true, reason: 'membership change' });
    for (const membership of [ undefined, 'invite', 'leave', 'ban' ] as const) {
      expect(inboundWriteAuthority({ grant: true, type: 'm.room.member', ...(membership === undefined ? {} : { membership }) }).allowed)
        .toBe(true);
    }
  });
});
