import { describe, expect, it } from 'vitest';
import { parseMembershipInvitations, parseMembershipOperation } from '../../../src/api/matrix/membershipOperation';

const owner = 'https://pod.example/alice/profile/card#me';
const bob = 'https://pod.example/bob/profile/card#me';
const binding = { purpose: 'membership', credentialRef: ' ref ', version: 2, issuer: 'https://issuer.example/' };
const invitation = { id: ' invite ', inviterWebId: owner, createdAt: 0 };
function operation(kind = 'invite', phase = 'committed') {
  return { format: 1, operationId: ' event ', kind, phase, actor: { webId: owner, podUrl: 'https://pod.example/alice/' },
    targetWebId: bob, authority: kind === 'invite' ? null : binding,
    expected: { authorWebId: owner, participants: [owner], memberRoles: null, invitation },
    event: { createdAt: 0, content: { membership: kind } }, ownerRecovery: null };
}
describe('strict membership recovery records', () => {
  it('retains exact invitation values and accepts the empty map', () => {
    expect(parseMembershipInvitations({ [bob]: invitation })).toEqual({ [bob]: invitation });
    expect(parseMembershipInvitations({})).toEqual({});
  });
  it.each([null, [], { bad: invitation }, { [bob]: { ...invitation, reason: 'extra' } },
    { [bob]: { ...invitation, inviterWebId: 'relative' } }, { [bob]: { ...invitation, id: ' ' } }])('rejects malformed invitations %j', value => {
    expect(parseMembershipInvitations(value)).toBeUndefined();
  });
  it('preserves absent versus present-empty expected roles and frozen strings', () => {
    expect(parseMembershipOperation(operation())).toEqual(operation());
    const empty = operation(); empty.expected.memberRoles = {} as never;
    expect(parseMembershipOperation(empty)?.expected.memberRoles).toEqual({});
  });
  it.each([['invite', 'committed'], ['invite', 'complete'], ['join', 'join-read-pending'], ['join', 'committed'],
    ['join', 'complete'], ['leave', 'leave-read-pending'], ['leave', 'leave-roster-pending'], ['leave', 'committed'], ['leave', 'complete']])('accepts only declared %s/%s stages', (kind, phase) => {
    expect(parseMembershipOperation(operation(kind, phase))).toEqual(operation(kind, phase));
  });
  it.each(['kick', 'cancel-invite', 'ban'])('rejects unsupported kind %s', kind => {
    expect(parseMembershipOperation(operation(kind))).toBeUndefined();
  });
  it('rejects unknown/missing fields, wrong phase, duplicated participants, malformed roles and content', () => {
    const base = operation();
    const missing = { ...base } as Record<string, unknown>; delete missing.ownerRecovery;
    const invalid = [null, [], { ...base, extra: true }, missing, operation('invite', 'join-read-pending'),
      { ...operation('join'), authority: null }, { ...base, actor: { ...base.actor, webId: 'relative' } },
      { ...base, expected: { ...base.expected, participants: [owner, owner] } },
      { ...base, expected: { ...base.expected, memberRoles: { [bob]: 'viewer' } } },
      { ...base, event: { ...base.event, content: { membership: 'invite', displayname: 'Bob' } } },
      { ...base, event: { ...base.event, content: { membership: 'join' } } },
      { ...base, ownerRecovery: { generation: 0, binding } }];
    for (const value of invalid) expect(parseMembershipOperation(value)).toBeUndefined();
  });
  it('keeps historical authority distinct from an explicit recovery binding', () => {
    const value = { ...operation('join'), ownerRecovery: { generation: 3, binding: { ...binding, version: 4 } } };
    expect(parseMembershipOperation(value)).toEqual(value);
  });
});
