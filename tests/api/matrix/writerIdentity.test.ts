import { describe, expect, it } from 'vitest';
import { writerMayClaim } from '../../../src/api/matrix/writerIdentity';

const alice = 'https://alice.example/card#me';
const bob = 'https://bob.example/card#me';
// Today's spelling; the switch to WebIDs as senders is exactly what the injected mapping absorbs.
const asMxid = (webId: string): string => `@u_${webId.includes('alice') ? 'alice' : 'bob'}:example.test`;

describe('who may write an event, once nothing is signed', () => {
  it('lets the hop write for the identity it is authenticated as', () => {
    expect(writerMayClaim({ sessionWebId: alice, sender: asMxid(alice), identityOf: asMxid }))
      .toEqual({ allowed: true, webId: alice });
  });

  it('refuses writing under somebody else\'s name, and says so', () => {
    const verdict = writerMayClaim({ sessionWebId: alice, sender: asMxid(bob), identityOf: asMxid });
    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed === false && verdict.reason).toBe('impersonation');
    expect(verdict.allowed === false && verdict.detail).toContain('may not write events as');
  });

  it('treats an unauthenticated write as its own failure, not as impersonation', () => {
    const verdict = writerMayClaim({ sender: asMxid(alice), identityOf: asMxid });
    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed === false && verdict.reason).toBe('no-session');
  });

  it('does not depend on how the sender is spelled', () => {
    // The target form: senders are WebIDs. The same check, no second implementation.
    const asWebId = (webId: string): string => webId;
    expect(writerMayClaim({ sessionWebId: alice, sender: alice, identityOf: asWebId }).allowed).toBe(true);
    expect(writerMayClaim({ sessionWebId: alice, sender: bob, identityOf: asWebId }).allowed).toBe(false);
  });
});
