import { describe, expect, it } from 'vitest';
import { solidPeerMayDeliver } from '../../../src/api/matrix/solidPeerBatch';

const alice = 'https://alice.example/card#me';
const bob = 'https://bob.example/card#me';
// The peer derives its own senders under the name it declares, so that is the name used here.
const asMxid = (webId: string, serverName: string): string =>
  `@u_${webId.includes('alice') ? 'alice' : 'bob'}:${serverName}`;
const batch = (over: Partial<Parameters<typeof solidPeerMayDeliver>[0]> = {}) => ({
  sessionWebId: alice,
  declaredOrigin: 'alice.example',
  senders: [ asMxid(alice, 'alice.example'), asMxid(alice, 'alice.example') ],
  identityOf: asMxid,
  ...over,
});

describe('a batch delivered with a Solid session instead of signatures', () => {
  it('accepts a batch whose events are all the session\'s own', () => {
    expect(solidPeerMayDeliver(batch())).toEqual({ allowed: true, webId: alice, origin: 'alice.example' });
  });

  it('refuses a batch that includes somebody else\'s event', () => {
    const verdict = solidPeerMayDeliver(batch({ senders: [ asMxid(alice, 'alice.example'), asMxid(bob, 'bob.example') ] }));
    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed === false && verdict.reason).toBe('impersonation');
  });

  it('uses the declared origin to spell the identity, not the name we were addressed by', () => {
    // The same WebID under the peer's own name is what its events carry; judging them under ours
    // would refuse every honest batch.
    expect(solidPeerMayDeliver(batch({ declaredOrigin: 'peer.example' })).allowed).toBe(false);
    expect(solidPeerMayDeliver(batch({
      declaredOrigin: 'peer.example',
      senders: [ asMxid(alice, 'peer.example') ],
    })).allowed).toBe(true);
  });

  it('refuses what it cannot judge, and says which it was', () => {
    expect(solidPeerMayDeliver(batch({ sessionWebId: undefined }))).toMatchObject({ reason: 'no-session' });
    expect(solidPeerMayDeliver(batch({ declaredOrigin: undefined }))).toMatchObject({ reason: 'no-origin' });
    expect(solidPeerMayDeliver(batch({ senders: [] }))).toMatchObject({ reason: 'empty' });
  });
});
