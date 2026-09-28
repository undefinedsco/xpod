/**
 * The identity grammar this protocol speaks, in one place.
 *
 * Identities are WebIDs (an agent is its own URI), and the `@local:server` form is still understood
 * because stored history and the Matrix-shaped surface carry it. What these tests pin is the rule
 * that matters to everything downstream: whatever the form, the same identity yields the same server
 * name — that is what a sender, a room and a key lookup are matched on.
 */
import { describe, expect, it } from 'vitest';
import { serverNameOf } from '../../../../src/api/matrix/protocol/authRules';
import { isUserIdentity, webIdServerName } from '../../../../src/api/matrix/protocol/serverName';

describe('reading a server name out of an identity', () => {
  it('reads a WebID by its host — the form this protocol writes', () => {
    expect(serverNameOf('https://alice.example/card#me')).toBe('alice.example');
    expect(serverNameOf('https://alice.example:8448/card#me')).toBe('alice.example:8448');
    expect(serverNameOf('https://pod.example/alice/.data/agents/scribe.ttl#this')).toBe('pod.example');
  });

  it('still reads the stored @local:server form', () => {
    expect(serverNameOf('@u_953b9a:alice.example')).toBe('alice.example');
    expect(serverNameOf('!room:alice.example')).toBe('alice.example');
    expect(serverNameOf('!room:alice.example:8448')).toBe('alice.example:8448');
  });

  it('agrees with the WebID rule rather than keeping a second one', () => {
    const webId = 'https://alice.example/card#me';
    expect(serverNameOf(webId)).toBe(webIdServerName(webId));
  });

  it('refuses what has no server to address', () => {
    expect(serverNameOf(undefined)).toBeUndefined();
    expect(serverNameOf('')).toBeUndefined();
    expect(serverNameOf('@nocolon')).toBeUndefined();
    expect(serverNameOf('not a url')).toBeUndefined();
  });

  it('knows which values are user identities', () => {
    expect(isUserIdentity('https://alice.example/card#me')).toBe(true);
    expect(isUserIdentity('https://pod.example/alice/.data/agents/scribe.ttl#this')).toBe(true);
    expect(isUserIdentity('@u_953b9a:alice.example')).toBe(true);
    expect(isUserIdentity('@nocolon')).toBe(false);
    expect(isUserIdentity('not a url')).toBe(false);
    expect(isUserIdentity('')).toBe(false);
  });
});
