import { describe, expect, it } from 'vitest';
import {
  AUTHORIZATION_PROFILE_DECLARATION_MEDIA_TYPE,
  AUTHORIZATION_PROFILE_DECLARATION_PROFILE,
  AUTHORIZATION_PROFILE_NEGOTIATION_MEDIA_TYPE,
  AUTHORIZATION_PROFILE_NEGOTIATION_PROFILE,
  parseAuthorizationProfileDeclaration,
  parseAuthorizationProfileNegotiationRequest,
  serializeAuthorizationProfileDeclaration,
} from '../../src/storage/rdf/AuthorizationObservation';

const CONTEXT = 'a'.repeat(64);
const CHALLENGE = 'b'.repeat(32);
const DIGEST = 'c'.repeat(64);

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    profile: AUTHORIZATION_PROFILE_NEGOTIATION_PROFILE,
    sourceIri: 'http://localhost/room/doc#msg',
    expectedSourceDigest: DIGEST,
    targetWebId: 'https://agent.example/profile#me',
    contextDigest: CONTEXT,
    challenge: CHALLENGE,
    ...overrides,
  };
}

function declaration(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    profile: AUTHORIZATION_PROFILE_DECLARATION_PROFILE,
    guardedPolicyProfile: 'wac-ground-v1',
    requesterWebId: 'https://owner.example/profile#me',
    targetWebId: 'https://agent.example/profile#me',
    sourceIri: 'http://localhost/room/doc#msg',
    sourceDigest: DIGEST,
    contextDigest: CONTEXT,
    challenge: CHALLENGE,
    ...overrides,
  };
}

describe('A2N profile negotiation closed wire', () => {
  it('exposes the two fixed media types and profiles', () => {
    expect(AUTHORIZATION_PROFILE_NEGOTIATION_MEDIA_TYPE).toBe('application/vnd.xpod.authorization-profile-negotiation+json');
    expect(AUTHORIZATION_PROFILE_DECLARATION_MEDIA_TYPE).toBe('application/vnd.xpod.authorization-profile+json');
    expect(AUTHORIZATION_PROFILE_NEGOTIATION_PROFILE).toBe('a2-profile-negotiation-v1');
    expect(AUTHORIZATION_PROFILE_DECLARATION_PROFILE).toBe('a2-profile-declaration-v1');
  });

  it('parses the exact closed negotiation record and keeps the full source fragment', () => {
    const parsed = parseAuthorizationProfileNegotiationRequest(request());
    expect(parsed.profile).toBe(AUTHORIZATION_PROFILE_NEGOTIATION_PROFILE);
    expect(parsed.sourceIri).toBe('http://localhost/room/doc#msg');
    expect(parsed.expectedSourceDigest).toBe(DIGEST);
    expect(parsed.challenge).toBe(CHALLENGE);
  });

  it('refuses extra keys, the A1 profile, wrong version and malformed digests', () => {
    expect(() => parseAuthorizationProfileNegotiationRequest(request({ extra: true }))).toThrow();
    expect(() => parseAuthorizationProfileNegotiationRequest(request({ profile: 'acp-agent-read-v1' }))).toThrow();
    expect(() => parseAuthorizationProfileNegotiationRequest(request({ version: 2 }))).toThrow();
    expect(() => parseAuthorizationProfileNegotiationRequest(request({ expectedSourceDigest: 'xyz' }))).toThrow();
    expect(() => parseAuthorizationProfileNegotiationRequest(request({ challenge: 'A'.repeat(32) }))).toThrow();
    expect(() => parseAuthorizationProfileNegotiationRequest(request({ contextDigest: 'a'.repeat(63) }))).toThrow();
  });

  it('keeps source routing queryfree while admitting full identity queries on the target', () => {
    expect(() => parseAuthorizationProfileNegotiationRequest(request({ sourceIri: 'http://localhost/room/doc?q=1#msg' }))).toThrow();
    const target = 'https://agent.example/profile/bob-card?account=bob#me';
    expect(parseAuthorizationProfileNegotiationRequest(request({ targetWebId: target })).targetWebId).toBe(target);
  });

  it('refuses credential-bearing, escaped and non-canonical identities', () => {
    expect(() => parseAuthorizationProfileNegotiationRequest(request({ sourceIri: 'http://user:pass@localhost/room#m' }))).toThrow();
    expect(() => parseAuthorizationProfileNegotiationRequest(request({ targetWebId: 'https://user:pass@agent.example/p?x=1#me' }))).toThrow();
    expect(() => parseAuthorizationProfileNegotiationRequest(request({ targetWebId: 'https://agent.example/profile%2fescape?x=1#me' }))).toThrow();
    expect(() => parseAuthorizationProfileNegotiationRequest(request({ targetWebId: 'HTTPS://agent.example/profile?x=1#me' }))).toThrow();
  });
});

describe('A2N profile declaration closed wire', () => {
  it('parses and serializes exactly the declaration keys in order', () => {
    const parsed = parseAuthorizationProfileDeclaration(declaration());
    const payload = serializeAuthorizationProfileDeclaration(parsed);
    expect(Object.keys(JSON.parse(payload))).toEqual([
      'version', 'profile', 'guardedPolicyProfile', 'requesterWebId', 'targetWebId', 'sourceIri',
      'sourceDigest', 'contextDigest', 'challenge',
    ]);
    expect(parsed.guardedPolicyProfile).toBe('wac-ground-v1');
    expect(parsed.requesterWebId).toBe('https://owner.example/profile#me');
    expect(parseAuthorizationProfileDeclaration(JSON.parse(payload))).toEqual(parsed);
  });

  it('accepts both maintained profiles and refuses any other label', () => {
    expect(parseAuthorizationProfileDeclaration(declaration({ guardedPolicyProfile: 'acp-ground-v1' })).guardedPolicyProfile)
      .toBe('acp-ground-v1');
    expect(() => parseAuthorizationProfileDeclaration(declaration({ guardedPolicyProfile: 'unsupported' }))).toThrow();
    expect(() => parseAuthorizationProfileDeclaration(declaration({ guardedPolicyProfile: 'wacl' }))).toThrow();
  });

  it('refuses guard/read/policy/credential leakage and extra keys', () => {
    expect(() => parseAuthorizationProfileDeclaration(declaration({ guard: { profile: 'wac-ground-v1' } }))).toThrow();
    expect(() => parseAuthorizationProfileDeclaration(declaration({ read: [] }))).toThrow();
    expect(() => parseAuthorizationProfileDeclaration(declaration({ authorization: 'x' }))).toThrow();
    expect(() => parseAuthorizationProfileDeclaration(declaration({ extra: 1 }))).toThrow();
  });

  it('refuses a wrong version/profile and malformed digests', () => {
    expect(() => parseAuthorizationProfileDeclaration(declaration({ version: 2 }))).toThrow();
    expect(() => parseAuthorizationProfileDeclaration(declaration({ profile: 'a2-profile-negotiation-v1' }))).toThrow();
    expect(() => parseAuthorizationProfileDeclaration(declaration({ sourceDigest: 'xy' }))).toThrow();
    expect(() => parseAuthorizationProfileDeclaration(declaration({ challenge: 'b'.repeat(31) }))).toThrow();
  });

  it('keeps full query+fragment identity byte-for-byte and source routing queryfree', () => {
    const target = 'https://agent.example/profile/bob-card?account=bob#me';
    expect(parseAuthorizationProfileDeclaration(declaration({ targetWebId: target })).targetWebId).toBe(target);
    expect(() => parseAuthorizationProfileDeclaration(declaration({ sourceIri: 'http://localhost/room/doc?q=1' }))).toThrow();
    expect(parseAuthorizationProfileDeclaration(declaration({ sourceIri: 'http://localhost/room/doc#msg' })).sourceIri)
      .toBe('http://localhost/room/doc#msg');
  });
});
