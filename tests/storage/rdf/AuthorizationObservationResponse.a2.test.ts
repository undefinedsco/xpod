import { describe, expect, it } from 'vitest';
import {
  AUTHORIZATION_OBSERVATION_PROFILE,
  parseAuthorizationObservationResponse,
} from '../../../src/storage/rdf/AuthorizationObservation';
import { parseGuardedPolicySnapshot, parseGuardedPolicyUpdate } from '../../../src/storage/rdf/GuardedPolicySnapshot';

/**
 * Pure closed-wire tests for the A2 client response parser. No HTTP, no server: these lock the exact
 * key set, identity/digest rules, guard reuse and the read<->inventory bijection in isolation.
 */
const scope = 'https://pod.example/room/';
const doc = 'https://pod.example/room/index.ttl';
const wacGuard = {
  profile: 'wac-ground-v1' as const,
  scope,
  ancestors: [],
  resources: [
    { iri: scope, container: true, children: [ doc ], policyIri: `${scope}.acl` },
    { iri: doc, container: false, children: [], policyIri: `${doc}.acl` },
  ],
  policies: [
    { iri: `${scope}.acl`, kind: 'wac' as const, state: 'absent404' as const, digest: null },
    { iri: `${doc}.acl`, kind: 'wac' as const, state: 'absent404' as const, digest: null },
  ],
};
const acpGuard = {
  ...wacGuard,
  profile: 'acp-ground-v1' as const,
  resources: wacGuard.resources.map(row => ({ ...row, policyIri: row.policyIri.replace(/\.acl$/u, '.acr') })),
  policies: wacGuard.policies.map(row => ({ ...row, iri: row.iri.replace(/\.acl$/u, '.acr'), kind: 'acp' as const })),
};
function response(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    profile: AUTHORIZATION_OBSERVATION_PROFILE,
    requesterWebId: 'https://owner.example/profile#me',
    targetWebId: 'https://agent.example/profile?account=a#me',
    sourceIri: `${doc}#this`,
    sourceDigest: 'a'.repeat(64),
    contextDigest: 'b'.repeat(64),
    challenge: 'c'.repeat(32),
    guard: acpGuard,
    read: [ { iri: scope, allowed: true }, { iri: doc, allowed: false } ],
    ...overrides,
  };
}

describe('A2 authorization observation response closed wire', () => {
  it('parses the exact record and preserves full requester/target/source identity', () => {
    const parsed = parseAuthorizationObservationResponse(response());
    expect(parsed.profile).toBe(AUTHORIZATION_OBSERVATION_PROFILE);
    expect(parsed.requesterWebId).toBe('https://owner.example/profile#me');
    expect(parsed.targetWebId).toBe('https://agent.example/profile?account=a#me');
    expect(parsed.sourceIri).toBe(`${doc}#this`);
    expect(parsed.guard.profile).toBe('acp-ground-v1');
    expect(parsed.read).toEqual([ { iri: scope, allowed: true }, { iri: doc, allowed: false } ]);
  });

  it('reuses the ONE pure guard validator (same acceptance as the guarded update envelope)', () => {
    expect(parseGuardedPolicySnapshot(acpGuard)).toEqual(parseGuardedPolicyUpdate({ version: 1, update: 'x', guard: acpGuard }).guard);
    const malformed = { ...acpGuard, extra: true };
    expect(() => parseGuardedPolicySnapshot(malformed)).toThrow();
    expect(() => parseAuthorizationObservationResponse(response({ guard: malformed }))).toThrow();
  });

  it('rejects missing or extra top-level keys and a wrong version/profile', () => {
    const { challenge, ...missing } = response();
    expect(() => parseAuthorizationObservationResponse(missing)).toThrow();
    expect(() => parseAuthorizationObservationResponse(response({ extra: 1 }))).toThrow();
    expect(() => parseAuthorizationObservationResponse(response({ version: 2 }))).toThrow();
    expect(() => parseAuthorizationObservationResponse(response({ profile: 'a2-profile-declaration-v1' }))).toThrow();
    expect(challenge).toBe('c'.repeat(32));
  });

  it('rejects malformed digests/challenge shapes and credential or non-canonical identities', () => {
    expect(() => parseAuthorizationObservationResponse(response({ sourceDigest: 'a'.repeat(63) }))).toThrow();
    expect(() => parseAuthorizationObservationResponse(response({ contextDigest: 'A'.repeat(64) }))).toThrow();
    expect(() => parseAuthorizationObservationResponse(response({ challenge: 'c'.repeat(31) }))).toThrow();
    expect(() => parseAuthorizationObservationResponse(response({ sourceIri: `${doc}?q=1#this` }))).toThrow();
    expect(() => parseAuthorizationObservationResponse(response({ requesterWebId: 'https://user:pass@owner.example/#me' }))).toThrow();
  });

  it('requires read to be an exact bijection of the guarded inventory (one boolean per ordinary resource)', () => {
    expect(() => parseAuthorizationObservationResponse(response({ read: [] }))).toThrow();
    expect(() => parseAuthorizationObservationResponse(response({ read: [ { iri: scope, allowed: true } ] }))).toThrow();
    expect(() => parseAuthorizationObservationResponse(response({ read: [
      { iri: scope, allowed: true }, { iri: doc, allowed: false }, { iri: `${scope}extra`, allowed: false },
    ] }))).toThrow();
    expect(() => parseAuthorizationObservationResponse(response({ read: [
      { iri: scope, allowed: true }, { iri: scope, allowed: false },
    ] }))).toThrow();
    expect(() => parseAuthorizationObservationResponse(response({ read: [
      { iri: scope, allowed: 'yes' }, { iri: doc, allowed: false },
    ] }))).toThrow();
    expect(() => parseAuthorizationObservationResponse(response({ read: [
      { iri: scope, allowed: true, extra: 1 }, { iri: doc, allowed: false },
    ] }))).toThrow();
  });

  it('carries the guard profile kind exactly (never accepts a mismatched policy engine)', () => {
    const mixed = { ...acpGuard, policies: acpGuard.policies.map(row => ({ ...row, kind: 'wac' })) };
    expect(() => parseAuthorizationObservationResponse(response({ guard: mixed }))).toThrow();
  });
});
