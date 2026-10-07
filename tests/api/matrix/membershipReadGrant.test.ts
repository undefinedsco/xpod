import { describe, expect, it } from 'vitest';
import { grantAuthorizationIri, parseMembershipReadGrant, parseMembershipReadGrants,
  findMembershipReadGrant, type MembershipReadGrant } from '../../../src/api/matrix/membershipReadGrant';

const binding = { purpose: 'membership' as const, credentialRef: 'ref', version: 1, issuer: 'https://i.example/' };
const base = { actorWebId: 'https://a.example/profile/card#me', sourceIri: 'https://o.example/chat/index.ttl#room',
  joinOperationId: '$join', authorPodUrl: { webId: 'https://o.example/profile/card#me', podUrl: 'https://o.example/' },
  binding, createdAt: 10, state: 'reserved' as const };

describe('durable membership Read-grant control state', () => {
  it('round-trips a reserved grant without a policy/authorization and rejects an installed grant without one', () => {
    expect(parseMembershipReadGrant(base)).toEqual(base);
    expect(parseMembershipReadGrant({ ...base, state: 'installed' })).toBeUndefined();
    const installed: MembershipReadGrant = { ...base, state: 'installed',
      policyIri: 'https://o.example/policies/room', authorizationIri: 'https://o.example/policies/room#membership-read-abc' };
    expect(parseMembershipReadGrant(installed)).toEqual(installed);
  });
  it('rejects malformed, extra-key, mismatched-key and mismatched-document grants', () => {
    expect(parseMembershipReadGrant({ ...base, extra: 1 })).toBeUndefined();
    expect(parseMembershipReadGrant({ ...base, actorWebId: 'not-uri' })).toBeUndefined();
    expect(parseMembershipReadGrant({ ...base, joinOperationId: '' })).toBeUndefined();
    expect(parseMembershipReadGrant({ ...base, binding: { ...binding, version: 0.5 } })).toBeUndefined();
    expect(parseMembershipReadGrant({ ...base, state: 'installed', policyIri: 'https://o.example/p',
      authorizationIri: 'https://o.example/other#x' })).toBeUndefined();
    expect(parseMembershipReadGrants({ 'https://x.example/#me': base })).toBeUndefined();
  });
  it('keys grants by actor and never collides a legacy look-alike with a distinct operation IRI', () => {
    const grants = parseMembershipReadGrants({ [base.actorWebId]: base })!;
    expect(findMembershipReadGrant(grants, base.actorWebId)).toEqual(base);
    expect(findMembershipReadGrant(grants, 'https://missing.example/#me')).toBeUndefined();
    const one = grantAuthorizationIri('https://o.example/p', base.actorWebId, '$join', 'https://o.example/chat/index.ttl#one');
    const two = grantAuthorizationIri('https://o.example/p', base.actorWebId, '$other', 'https://o.example/chat/index.ttl#one');
    const sameDocDifferentFragment = grantAuthorizationIri('https://o.example/p', base.actorWebId, '$join', 'https://o.example/chat/index.ttl#two');
    expect(one).not.toBe(two);
    // Full source identity including the fragment: same document, same policy/actor/op must differ.
    expect(one).not.toBe(sameDocDifferentFragment);
    expect(one.startsWith('https://o.example/p#')).toBe(true);
  });
});
